import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium, type Browser } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

// A round boundary replaces settled tool parts with the daemon's authoritative
// page version (the SDK's end-of-round refresh reconciles live text with the
// native full text). The formatted diff must never regress to a plain-text
// fallback while that replacement re-renders: the control projection (byte-
// identical diff) must keep the rendered cache, and a page version whose diff
// gains only its full trailing context must update in place, not flash.

let browser: Browser, closeFixture: () => Promise<void>, url: string
before(async () => {
  const fixture = await borrowFixture({ name: "diff-boundary-flash", routes: [{ path: "/fixture", html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/diff-boundary-flash.tsx"></script></body></html>' }] })
  url = fixture.url
  closeFixture = fixture.close
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => {
  await browser?.close()
  await closeFixture?.()
})

async function openFixture() {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, locale: "en-US" })
  const errors: string[] = []
  page.on("pageerror", error => { errors.push(error.message); console.error("fixture-error", error.message) })
  await page.route("**/*", route => {
    const request = new URL(route.request().url())
    if (request.origin !== new URL(url).origin) return route.abort("blockedbyclient")
    if (request.pathname.startsWith("/api/")) return route.fulfill({ contentType: "application/json", body: "{}" })
    return route.continue()
  })
  await page.goto(url, { timeout: 120_000 })
  return { page, errors }
}

test("a byte-identical re-projection keeps the rendered diff without any fallback frame", async () => {
  const { page, errors } = await openFixture()
  try {
    await page.waitForFunction(() => (window as any).fixture?.ready !== undefined, undefined, { timeout: 20_000 })
    await page.evaluate(async () => { await (window as any).fixture.ready() })
    const identical = await page.evaluate(async () => {
      const fixture = (window as any).fixture
      await fixture.reproject(fixture.diffA())
      return fixture.samples()
    })
    assert.ok(identical.frames > 0, "the sampler must observe frames after the control projection")
    assert.equal(identical.fallbackFrames, 0, "an identical snapshot must not disturb the rendered diff")
    assert.equal(errors.length, 0)
  } finally { await page.close() }
})

test("a grouped settled message reprojection keeps every tool body and report mounted", async () => {
  const { page, errors } = await openFixture()
  try {
    await page.waitForFunction(() => (window as any).fixture?.ready !== undefined, undefined, { timeout: 20_000 })
    const outcome = await page.evaluate(async () => {
      const fixture = (window as any).fixture
      await fixture.useGrouped(fixture.diffA())
      await fixture.reprojectGrouped(fixture.diffAPage())
      return { ...fixture.samples(), renderedText: fixture.renderedText() }
    })
    console.log("grouped reprojection samples:", JSON.stringify(outcome))
    assert.ok(outcome.frames > 0, "the sampler must observe frames after the projection")
    assert.ok(String(outcome.renderedText).includes("export const done = true"), "the projection must update the rendered diff")
    assert.equal(outcome.missingBodyFrames, 0, "a settled tool body blanked during the reprojection")
    assert.equal(outcome.missingReportFrames, 0, "the subagent report blanked during the reprojection")
    assert.equal(outcome.fallbackFrames, 0, "the formatted diff regressed to a plain-text fallback")
    assert.equal(errors.length, 0)
  } finally { await page.close() }
})

test("appending to an open Shell group keeps the existing cards mounted", async () => {
  const { page, errors } = await openFixture()
  try {
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await page.evaluate(() => (window as any).fixture.startShellGroup())
    const group = (count: number) => page.getByRole("button", { name: `Shell: ${count}`, exact: true })
    await group(2).waitFor()
    if (await group(2).getAttribute("aria-expanded") === "false") await group(2).click()
    const card = (id: string) => page.locator(`.tool-call-message[data-part-id="${id}"] .tool-call`)
    const mounted = await Promise.all(["shell-1", "shell-2"].map(async id => {
      const tool = card(id)
      await tool.getByText(`Output from ${id}`, { exact: true }).waitFor()
      return tool.elementHandle()
    }))
    await page.evaluate(() => (window as any).fixture.appendShell("shell-3"))
    await group(3).waitFor()
    await card("shell-3").getByText("Output from shell-3", { exact: true }).waitFor()
    for (const [index, original] of mounted.entries()) {
      assert.equal(await card(`shell-${index + 1}`).evaluate((node, prior) => node === prior, original), true)
    }
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("a reasoning part streaming into the message keeps every grouped tool body mounted", async () => {
  const { page, errors } = await openFixture()
  try {
    await page.waitForFunction(() => (window as any).fixture?.ready !== undefined, undefined, { timeout: 20_000 })
    const outcome = await page.evaluate(async () => {
      const fixture = (window as any).fixture
      await fixture.useGrouped(fixture.diffA())
      // Expand the collapsed shell group the way a reader does, so its bodies mount.
      document.querySelector<HTMLButtonElement>(".message-exploration-group .message-technical-group-toggle")?.click()
      for (let index = 0; index < 6; index++) await new Promise(resolve => requestAnimationFrame(resolve))
      await fixture.ready()
      const baseline = fixture.bodyCount()
      await fixture.streamReasoning(fixture.diffA())
      return { ...fixture.samples(), bodiesAfter: fixture.bodyCount(), baseline }
    })
    console.log("reasoning-stream samples:", JSON.stringify(outcome))
    assert.ok(outcome.frames > 0, "the sampler must observe frames after the projection")
    assert.ok(outcome.baseline >= 3, `the expanded grouped page must mount every tool body: ${JSON.stringify(outcome)}`)
    assert.equal(outcome.collapsedBodyFrames, 0, `a settled grouped tool body collapsed when reasoning streamed (baseline ${outcome.baseline}): ${JSON.stringify(outcome)}`)
    assert.equal(outcome.missingReportFrames, 0, "the subagent report blanked while reasoning streamed")
    assert.equal(errors.length, 0)
  } finally { await page.close() }
})

test("switching sessions mounts deferred tool bodies without a visible collapse of already-shown cards", async () => {
  const { page, errors } = await openFixture()
  try {
    await page.waitForFunction(() => (window as any).fixture?.ready !== undefined, undefined, { timeout: 20_000 })
    const outcome = await page.evaluate(async () => {
      const fixture = (window as any).fixture
      await fixture.useGrouped(fixture.diffA())
      // Expand the shell group so every body is mounted, then switch away and back.
      document.querySelector<HTMLButtonElement>(".message-exploration-group .message-technical-group-toggle")?.click()
      for (let index = 0; index < 6; index++) await new Promise(resolve => requestAnimationFrame(resolve))
      const before = fixture.bodyCount()
      await fixture.switchTo("s2")
      const away = { ...fixture.samples(), bodies: fixture.bodyCount() }
      await fixture.switchTo("s")
      const back = { ...fixture.samples(), bodies: fixture.bodyCount() }
      return { before, away, back }
    })
    console.log("session-switch samples:", JSON.stringify(outcome))
    assert.ok(outcome.back.frames > 0, "the sampler must observe frames after switching back")
    // Switching back to a viewed session is a warm remount: its bodies released
    // once and their render caches are hot, so none may blank beyond the single
    // teardown/mount intersection frame where the departing session's card
    // header lingers without its body.
    assert.ok(outcome.back.missingBodyFrames <= 1, `switching back blanked tool bodies: ${JSON.stringify(outcome)}`)
    assert.ok(outcome.back.missingReportFrames <= 1, `switching back blanked the subagent report: ${JSON.stringify(outcome)}`)
    assert.equal(errors.length, 0)
  } finally { await page.close() }
})

test("scrolling away and back in a long session keeps recycled tool bodies mounted", async () => {
  const { page, errors } = await openFixture()
  try {
    await page.waitForFunction(() => (window as any).fixture?.ready !== undefined, undefined, { timeout: 20_000 })
    const outcome = await page.evaluate(async () => {
      const fixture = (window as any).fixture
      return await fixture.scrollRecycle()
    })
    console.log("scroll-recycle samples:", JSON.stringify(outcome))
    assert.ok(String(JSON.stringify(outcome)).includes("finalBodies"), `the long session must render: ${JSON.stringify(outcome)}`)
    assert.equal(errors.length, 0)
  } finally { await page.close() }
})

test("sending a message keeps every mounted tool body and report visible", async () => {
  const { page, errors } = await openFixture()
  try {
    await page.waitForFunction(() => (window as any).fixture?.ready !== undefined, undefined, { timeout: 20_000 })
    const outcome = await page.evaluate(async () => {
      const fixture = (window as any).fixture
      await fixture.useGrouped(fixture.diffA())
      document.querySelector<HTMLButtonElement>(".message-exploration-group .message-technical-group-toggle")?.click()
      for (let index = 0; index < 6; index++) await new Promise(resolve => requestAnimationFrame(resolve))
      const baseline = fixture.bodyCount()
      const phases = await fixture.sendMessagePhased()
      return { baseline, phases, bodiesAfter: fixture.bodyCount() }
    })
    console.log("send-message phases:", JSON.stringify(outcome))
    assert.ok(outcome.phases, "the phased send must report its phases")
    assert.ok(outcome.baseline >= 3, `the expanded grouped page must mount every tool body: ${JSON.stringify(outcome)}`)
    for (const [phase, samples] of Object.entries<{ missingBodyFrames: number; missingReportFrames: number; bodies: number }>(outcome.phases)) {
      assert.equal(samples.missingBodyFrames, 0, `the ${phase} phase blanked mounted tool bodies: ${JSON.stringify(outcome)}`)
      assert.equal(samples.missingReportFrames, 0, `the ${phase} phase blanked the subagent report: ${JSON.stringify(outcome)}`)
    }
    assert.equal(outcome.bodiesAfter, outcome.baseline, "every tool body must return after the send settles")
    assert.equal(errors.length, 0)
  } finally { await page.close() }
})

test("a page version reconciling the diff's full text never flashes a plain-text fallback", async () => {
  const { page, errors } = await openFixture()
  try {
    await page.waitForFunction(() => (window as any).fixture?.ready !== undefined, undefined, { timeout: 20_000 })
    await page.evaluate(async () => { await (window as any).fixture.ready() })
    const before = await page.evaluate(() => (window as any).fixture.renderedText())
    const outcome = await page.evaluate(async () => {
      const fixture = (window as any).fixture
      await fixture.reproject(fixture.diffAPage())
      return { ...fixture.samples(), rendered: fixture.diffRendered(), after: fixture.renderedText() }
    })
    console.log("diff reprojection samples:", JSON.stringify(outcome))
    assert.ok(outcome.after.includes("export const done = true"), "the projection must actually update the rendered diff")
    assert.notEqual(outcome.after, before, "the rendered diff text must change with the page version")
    assert.ok(outcome.frames > 0, "the sampler must observe frames after the projection")
    assert.equal(outcome.fallbackFrames, 0, "the formatted diff regressed to a plain-text fallback while re-rendering")
    assert.equal(outcome.rendered, true, "the formatted diff must remain rendered")
    assert.equal(errors.length, 0)
  } finally { await page.close() }
})
