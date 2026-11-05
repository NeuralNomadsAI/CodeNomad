import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
before(async () => {
  ;({ url } = await borrowFixture({ name: "multiserver-actions", routes: [{ path: "/actions", html: '<html><body><div id="root" style="display:flex;height:700px;width:1000px"></div><script type="module" src="/tests/browser/fixtures/multiserver-actions.tsx"></script></body></html>' }] }))
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })
async function setup() {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, locale: "en-US" })
  const errors: string[] = [], files: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => {
    if (/\/files(?:\/search)?\?/.test(route.request().url())) files.push(route.request().url())
    return route.fulfill({ json: route.request().url().includes("permission-receipts") ? { receipts: [] } : {} })
  })
  await page.goto(url)
  await page.waitForFunction(() => Boolean((window as any).fixture))
  return { page, errors, files, input: page.locator("textarea:visible").first() }
}
test("explicit mention menu explains unavailable files, keeps native skills, and cannot synthesize root references", async () => {
  const f = await setup()
  try {
    await f.input.fill("@")
    await f.page.getByText("Project file references are unavailable on this server. You can mention its agents and skills.", { exact: true }).waitFor()
    await f.page.getByText("Skill A", { exact: true }).last().waitFor()
    await f.page.getByText("Skill A", { exact: true }).last().click()
    assert.equal((await f.page.evaluate(() => (window as any).fixture.attachments()))[0].source.id, "skill")
    await f.input.fill("@./")
    await f.page.locator(".dropdown-surface").waitFor()
    for (const key of ["Tab", "Enter", "Shift+Enter"]) await f.input.press(key)
    assert.equal(await f.input.inputValue(), "@./")
    assert.equal((await f.page.evaluate(() => (window as any).fixture.attachments())).length, 1)
    assert.deepEqual(f.files, [])
    assert.equal(await f.page.getByText("Workspace root", { exact: false }).count(), 0)
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})
test("real composer restores the failed draft after rotation during instructions without emitting a prompt", async () => {
  const f = await setup()
  try {
    await f.page.evaluate(() => (window as any).fixture.block("instruction"))
    await f.input.fill("Keep attempted draft")
    await f.input.press("Enter")
    await f.page.waitForFunction(() => (window as any).fixture.calls().some((call: any) => call.method === "instruction"))
    await f.page.evaluate(() => { (window as any).fixture.rotate(); (window as any).fixture.release() })
    await f.page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("textarea")?.value === "Keep attempted draft")
    const calls = await f.page.evaluate(() => (window as any).fixture.calls())
    assert.equal(calls.filter((call: any) => call.method === "prompt").length, 0)
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})
test("latest-page await cannot recapture a replacement connection before sending", async () => {
  const f = await setup()
  try {
    await f.page.evaluate(() => { (window as any).fixture.historical(); (window as any).fixture.block("messages") })
    await f.input.fill("Wait for latest")
    const before = await f.page.evaluate(() => (window as any).fixture.calls().filter((call: any) => call.method === "messages").length)
    await f.input.press("Enter")
    await f.page.waitForFunction(count => (window as any).fixture.calls().filter((call: any) => call.method === "messages").length > count, before)
    await f.page.evaluate(() => { (window as any).fixture.rotate(); (window as any).fixture.release() })
    await f.page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("textarea")?.value === "Wait for latest")
    const calls = await f.page.evaluate(() => (window as any).fixture.calls())
    assert.equal(calls.filter((call: any) => call.method === "prompt" || call.method === "instruction").length, 0)
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})

test("a failed send restores its source draft after switching targets without touching the destination draft", async () => {
  const f = await setup()
  try {
    await f.page.evaluate(() => (window as any).fixture.block("instruction"))
    await f.input.fill("Source A draft")
    await f.input.press("Enter")
    await f.page.waitForFunction(() => (window as any).fixture.calls().some((call: any) => call.method === "instruction"))
    await f.page.evaluate(() => (window as any).fixture.select("B"))
    await f.input.fill("Keep B draft")
    await f.page.evaluate(() => (window as any).fixture.release())
    await f.page.waitForTimeout(100)
    assert.equal(await f.input.inputValue(), "Keep B draft")
    assert.equal((await f.page.evaluate(() => (window as any).fixture.calls())).filter((call: any) => call.method === "prompt").length, 0)
    await f.page.evaluate(() => (window as any).fixture.select("A"))
    await f.page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("textarea")?.value === "Source A draft")
    assert.deepEqual(f.errors, [])
  } finally { await f.page.close() }
})
