import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Awaited<ReturnType<typeof chromium.launch>>, url: string
before(async () => {
  const fixture = await borrowFixture({ name: "bundles-confirmation", routes: [{ path: "/fixture",
    html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/bundles-confirmation.tsx"></script></body></html>' }] })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })
const frame = (page: Page, index = 0) => page.frameLocator(`iframe[title="Extension ${index}"]`).locator("body")
const snapshot = (page: Page) => page.evaluate(() => (window as any).fixture.snapshot())
const ask = async (page: Page, index = 0) => {
  await page.evaluate(index => (window as any).fixture.arm(index), index)
  return frame(page, index).evaluate(() => (window as any).ask())
}
async function open() {
  const page = await browser.newPage(), errors: string[] = [], consoles: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("console", message => consoles.push(message.text()))
  await page.addInitScript(() => { (window as any).EventSource = class { static OPEN = 1; readyState = 1; addEventListener() {} removeEventListener() {} close() {} } })
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  await page.goto(url)
  await frame(page).locator("#ready").filter({ hasText: "ready" }).waitFor()
  await frame(page, 1).locator("#ready").filter({ hasText: "ready" }).waitFor()
  const clean = async () => {
    const result = await frame(page).evaluate(() => ({ results: (window as any).results, changes: (window as any).changes, messages: (window as any).messages }))
    assert.deepEqual(errors, [])
    assert.ok(!JSON.stringify({ result, consoles }).includes("PRIVATE_"))
    assert.ok(!JSON.stringify(result).includes("documentDigest"))
    assert.ok(!JSON.stringify(result).includes("planID"))
  }
  return { page, clean, errors, consoles }
}

test("actual bridge ACK <1s before trusted view, Cancel focus, 30s human wait and single terminal admission", async () => {
  const { page, clean, errors, consoles } = await open()
  try {
    const started = Date.now(), ack = await ask(page)
    assert.equal(ack.outcome, "confirming"); assert.ok(Date.now() - started < 1_000)
    assert.match(ack.requestID, /^[a-f0-9]{32}$/)
    await page.getByRole("dialog").waitFor({ timeout: 3_000 }).catch(async error => {
      assert.fail(JSON.stringify({ error: String(error), snapshot: await snapshot(page), body: await page.locator("body").innerText(),
        messages: await frame(page).evaluate(() => (window as any).messages), errors, consoles }))
    })
    assert.deepEqual((await snapshot(page)).log.slice(0, 2), ["ack", "view"])
    assert.equal(await page.getByRole("button", { name: "Cancel", exact: true }).evaluate(el => document.activeElement === el), true)
    assert.match(await page.getByRole("dialog").innerText(), /Blender.*1\.0\.0/s)
    assert.match(await page.getByRole("dialog").innerText(), /OpenCode.*remote/s)
    await page.clock.install()
    await page.clock.fastForward(30_000)
    assert.equal((await snapshot(page)).pending, true)
    assert.equal((await snapshot(page)).dispatched, 0)
    await page.getByRole("button", { name: "Confirm", exact: true }).click()
    await page.waitForFunction(() => (window as any).fixture.snapshot().dispatched === 1)
    await page.waitForTimeout(50)
    assert.deepEqual(await frame(page).evaluate(() => (window as any).changes), [{ kind: "request", requestID: ack.requestID, outcome: "confirmed" }])
    await clean()
  } finally { await page.close() }
})

test("early synthetic click/double-click/Enter stay inert; >=600ms and duplicate activation admit only once", async () => {
  const { page, clean } = await open()
  try {
    await page.clock.install(); const ack = await ask(page); await page.getByRole("dialog").waitFor()
    const confirm = page.getByRole("button", { name: "Confirm", exact: true })
    assert.equal(await confirm.isDisabled(), true)
    await confirm.evaluate(el => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })) })
    assert.equal((await snapshot(page)).dispatched, 0)
    await page.clock.fastForward(499)
    await confirm.dispatchEvent("click"); assert.equal((await snapshot(page)).dispatched, 0)
    await page.clock.fastForward(101)
    assert.equal(await confirm.isDisabled(), false)
    await confirm.evaluate(el => { (el as HTMLButtonElement).click(); (el as HTMLButtonElement).click(); el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })) })
    await page.waitForFunction(() => (window as any).fixture.snapshot().dispatched === 1)
    await page.waitForTimeout(50)
    assert.deepEqual(await frame(page).evaluate(() => (window as any).changes), [{ kind: "request", requestID: ack.requestID, outcome: "confirmed" }])
    await clean()
  } finally { await page.close() }
})

test("one shared busy arbiter across owners; cancellation and failed admission produce distinct lossless request events beside state coalescing", async () => {
  const { page, clean } = await open()
  try {
    const first = await ask(page)
    assert.deepEqual(await ask(page, 1), { outcome: "busy" })
    await page.getByRole("button", { name: "Cancel", exact: true }).click()
    await page.evaluate(() => { (window as any).fixture.event(); (window as any).fixture.event(); (window as any).fixture.fail(true) })
    const second = await ask(page)
    await page.getByRole("dialog").waitFor()
    await page.clock.install(); await page.clock.fastForward(600)
    await page.getByRole("button", { name: "Confirm", exact: true }).click()
    await page.waitForFunction(() => !(window as any).fixture.snapshot().pending)
    await page.waitForTimeout(50)
    const changes = await frame(page).evaluate(() => (window as any).changes)
    assert.deepEqual(changes.filter((value: any) => value.kind === "request"), [
      { kind: "request", requestID: first.requestID, outcome: "cancelled" }, { kind: "request", requestID: second.requestID, outcome: "failed" }])
    assert.equal(changes.filter((value: any) => value.kind === "state").length, 1)
    assert.equal((await snapshot(page)).dispatched, 0)
    await clean()
  } finally { await page.close() }
})

test("real Enter initially cancels and repeated Enter on an enabled Confirm transmits only once", async () => {
  const { page, clean } = await open()
  try {
    await frame(page).click()
    const first = await ask(page); await page.getByRole("dialog").waitFor()
    await page.keyboard.press("Enter")
    await page.getByRole("dialog").waitFor({ state: "detached" })
    await page.waitForFunction(() => document.activeElement === document.querySelector('iframe[title="Extension 0"]'))
    assert.equal((await snapshot(page)).dispatched, 0)
    await page.clock.install()
    const second = await ask(page); await page.getByRole("dialog").waitFor()
    await page.clock.fastForward(600)
    await page.getByRole("button", { name: "Confirm", exact: true }).focus()
    await page.keyboard.press("Enter"); await page.keyboard.press("Enter")
    await page.waitForFunction(() => (window as any).fixture.snapshot().dispatched === 1)
    await page.waitForTimeout(50)
    assert.deepEqual(await frame(page).evaluate(() => (window as any).changes), [
      { kind: "request", requestID: first.requestID, outcome: "cancelled" }, { kind: "request", requestID: second.requestID, outcome: "confirmed" }])
    await clean()
  } finally { await page.close() }
})

test("two-minute expiry closes trusted view and emits exactly one expiry without invoking admission", async () => {
  const { page, clean } = await open()
  try {
    await page.clock.install(); const ack = await ask(page); await page.getByRole("dialog").waitFor()
    await page.clock.fastForward(120_000)
    assert.equal(await page.getByRole("dialog").count(), 0); assert.equal((await snapshot(page)).dispatched, 0)
    assert.deepEqual(await frame(page).evaluate(() => (window as any).changes), [{ kind: "request", requestID: ack.requestID, outcome: "expired" }])
    await clean()
  } finally { await page.close() }
})

test("consent revoke, document conflict, navigation round trip and late preparation never invoke callback", async () => {
  for (const transition of ["revoke", "mutateTarget", "navigate", "remount"] as const) {
    const { page, clean } = await open()
    try {
      await ask(page); await page.getByRole("dialog").waitFor()
      await page.evaluate(action => (window as any).fixture[action](), transition)
      if (transition === "mutateTarget") {
        await page.clock.install(); await page.clock.fastForward(600)
        await page.getByRole("button", { name: "Confirm", exact: true }).click()
      }
      await page.waitForFunction(() => !(window as any).fixture.snapshot().pending)
      assert.equal((await snapshot(page)).dispatched, 0, transition)
      if (transition === "navigate" || transition === "remount") await frame(page).locator("#ready").filter({ hasText: "ready" }).waitFor()
      await clean()
    } finally { await page.close() }
  }
  const { page } = await open()
  try {
    await page.evaluate(() => (window as any).fixture.pause(true))
    const ack = await ask(page); assert.equal(ack.outcome, "confirming")
    assert.equal(await page.getByRole("dialog").count(), 0)
    await page.evaluate(() => { (window as any).fixture.revoke(); (window as any).fixture.release() })
    await page.waitForTimeout(50)
    assert.equal(await page.getByRole("dialog").count(), 0); assert.equal((await snapshot(page)).dispatched, 0)
  } finally { await page.close() }
})
