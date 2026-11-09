import assert from "node:assert/strict"
import { before, after, test } from "node:test"
import { chromium, type Browser, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({ name: "speech-lifecycle", routes: [{ path: "/fixture", html: '<html><body><script type="module" src="/tests/browser/fixtures/speech-lifecycle.tsx"></script></body></html>' }] })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

async function withPage(body: (page: Page) => Promise<void>) {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill({ json: {} }))
  try {
    await page.goto(url)
    await page.waitForFunction(() => Boolean((window as any).fixture))
    await body(page)
    assert.deepEqual(errors, [])
  } finally { await page.close() }
}
const snapshot = (page: Page) => page.evaluate(() => (window as any).fixture.snapshot())
const state = (page: Page, key: string, expected: string) => page.waitForFunction(({ key, expected }) => (window as any).fixture.state(key) === expected, { key, expected })

for (const drift of [false, true]) test(`disposed real Index tool cards release their owners (identity changes: ${drift})`, () => withPage(async page => {
  const cdp = await page.context().newCDPSession(page)
  const samples: number[] = []
  for (const count of [2, 16, 100]) {
    await page.evaluate(({ count, drift }) => (window as any).fixture.cards(count, drift), { count, drift })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await cdp.send("HeapProfiler.collectGarbage")
    samples.push(await page.evaluate(() => (window as any).fixture.retained()))
  }
  console.log({ drift, retained: samples })
  // Allow a bounded transient tail, never historical growth across 118 identities.
  assert.ok(samples.at(-1)! <= 2, "disposed tool DOM must not accumulate after identity recycling")
}))

test("identity replacement stops its audio; duplicate identities keep distinct owners", () => withPage(async page => {
  await page.evaluate(() => { const f = (window as any).fixture; f.mount("a", "same"); f.mount("b", "same"); f.toggle("a") })
  await page.waitForFunction(() => (window as any).fixture.snapshot().pending === 1)
  await page.evaluate(() => (window as any).fixture.resolve(0))
  await state(page, "a", "playing")
  await page.evaluate(() => (window as any).fixture.remove("b"))
  await state(page, "a", "playing")
  assert.equal((await snapshot(page)).audios[0].paused, false)
  await page.evaluate(() => (window as any).fixture.change("a", "replacement"))
  await state(page, "a", "idle")
  const stopped = await snapshot(page)
  assert.deepEqual(stopped.audios[0], { paused: true, src: "", loads: 1 })
  assert.deepEqual(stopped.revoked, ["blob:speech-1"])
}))

test("only the newest request can play, including colliding identities and stale events", () => withPage(async page => {
  await page.evaluate(() => { const f = (window as any).fixture; f.mount("a", "same"); f.mount("b", "same"); f.toggle("a") })
  await page.waitForFunction(() => (window as any).fixture.snapshot().pending === 1)
  await page.evaluate(() => (window as any).fixture.toggle("b"))
  await page.waitForFunction(() => (window as any).fixture.snapshot().pending === 2)
  await page.evaluate(() => (window as any).fixture.resolve(1))
  await state(page, "b", "playing")
  await page.evaluate(() => (window as any).fixture.resolve(0))
  await state(page, "a", "idle")
  assert.equal((await snapshot(page)).audios.length, 1, "superseded response must not allocate audio")
  await page.evaluate(() => (window as any).fixture.toggle("a"))
  await page.waitForFunction(() => (window as any).fixture.snapshot().pending === 3)
  await page.evaluate(() => (window as any).fixture.resolve(2))
  await state(page, "a", "playing")
  await page.evaluate(() => (window as any).fixture.finish(0))
  await state(page, "a", "playing")
  await page.evaluate(() => (window as any).fixture.finish(1, "error"))
  await state(page, "a", "idle")
  assert.equal((await snapshot(page)).audios.every((audio: any) => audio.paused && audio.src === ""), true)
}))

test("stream disposal aborts pending work and revokes allocated audio", () => withPage(async page => {
  await page.evaluate(() => { const f = (window as any).fixture; f.mount("a", "stream", "streaming"); f.toggle("a") })
  await page.waitForFunction(() => (window as any).fixture.snapshot().pending === 1)
  await page.evaluate(() => { const f = (window as any).fixture; f.change("a", "new-stream"); f.resolve(0) })
  await state(page, "a", "idle")
  assert.deepEqual((await snapshot(page)).aborted, [true])
  assert.equal((await snapshot(page)).audios.length, 0, "late stream response cannot create audio")
  await page.evaluate(() => (window as any).fixture.toggle("a"))
  await page.waitForFunction(() => (window as any).fixture.snapshot().pending === 2)
  await page.evaluate(() => (window as any).fixture.resolve(1))
  await page.waitForFunction(() => (window as any).fixture.snapshot().audios.length === 1)
  await page.evaluate(() => (window as any).fixture.remove("a"))
  const stopped = await snapshot(page)
  assert.deepEqual(stopped.aborted, [true, true])
  assert.deepEqual(stopped.revoked, ["blob:speech-1"])
  assert.deepEqual(stopped.audios[0], { paused: true, src: "", loads: 1 })
}))

test("stop and disposal fence buffered responses and capabilities still loading", () => withPage(async page => {
  await page.evaluate(() => { const f = (window as any).fixture; f.mount("a", "buffered"); f.toggle("a") })
  await page.waitForFunction(() => (window as any).fixture.snapshot().pending === 1)
  await page.evaluate(() => { const f = (window as any).fixture; f.stop("a"); f.resolve(0) })
  await state(page, "a", "idle")
  await page.evaluate(() => (window as any).fixture.toggle("a"))
  await page.waitForFunction(() => (window as any).fixture.snapshot().pending === 2)
  await page.evaluate(() => { const f = (window as any).fixture; f.remove("a"); f.resolve(1) })
  await page.evaluate(() => {
    const f = (window as any).fixture
    f.holdCapabilities(); f.mount("b", "capabilities"); f.toggle("b"); f.remove("b"); f.resolveCapabilities()
  })
  // Cross one event-loop turn so all deliberately resolved continuations run.
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)))
  assert.equal((await snapshot(page)).pending, 2, "disposed capability wait must not start synthesis")
  assert.equal((await snapshot(page)).audios.length, 0)
}))
