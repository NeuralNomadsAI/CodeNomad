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

for (const phase of ["playing", "synthesis", "capabilities"]) test(`same-ID record replacement preserves speech during ${phase}`, () => withPage(async page => {
  await page.evaluate(phase => {
    const f = (window as any).fixture
    if (phase === "capabilities") f.holdCapabilities()
    f.mount("a", "same-message"); f.toggle("a")
  }, phase)
  if (phase !== "capabilities") await page.waitForFunction(() => (window as any).fixture.snapshot().pending === 1)
  if (phase === "playing") {
    await page.evaluate(() => (window as any).fixture.resolve(0))
    await state(page, "a", "playing")
  }
  await page.evaluate(() => (window as any).fixture.replace("a"))
  assert.equal(await page.evaluate(() => (window as any).fixture.state("a")), phase === "playing" ? "playing" : "loading")
  if (phase === "capabilities") {
    await page.evaluate(() => (window as any).fixture.resolveCapabilities())
    await page.waitForFunction(() => (window as any).fixture.snapshot().pending === 1)
  }
  if (phase !== "playing") {
    await page.evaluate(() => (window as any).fixture.resolve(0))
    await state(page, "a", "playing")
  }
  const playing = await snapshot(page)
  assert.deepEqual(playing.audios, [{ paused: false, src: "blob:speech-1", loads: 0 }])
  assert.deepEqual(playing.revoked, [])
  await page.evaluate(() => (window as any).fixture.change("a", "different-message"))
  await state(page, "a", "idle")
  assert.deepEqual((await snapshot(page)).revoked, ["blob:speech-1"])
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
  await state(page, "a", "playing")
  await page.evaluate(() => (window as any).fixture.remove("a"))
  const stopped = await snapshot(page)
  assert.deepEqual(stopped.aborted, [true, true])
  assert.deepEqual(stopped.revoked, ["blob:speech-1"])
  assert.deepEqual(stopped.audios[0], { paused: true, src: "", loads: 1 })
}))

test("streaming feeds later chunks while the audio decoder waits for enough data to play", () => withPage(async page => {
  await page.evaluate(() => { const f = (window as any).fixture; f.mount("a", "split", "streaming"); f.toggle("a") })
  await page.waitForFunction(() => (window as any).fixture.snapshot().pending === 1)
  await page.evaluate(() => (window as any).fixture.resolveSplit(0))
  await page.waitForFunction(() => (window as any).fixture.snapshot().audios[0]?.paused === false)
}))

test("stop and disposal fence buffered responses and capabilities still loading", () => withPage(async page => {
  await page.evaluate(() => { const f = (window as any).fixture; f.mount("a", "buffered"); f.toggle("a") })
  await page.waitForFunction(() => (window as any).fixture.snapshot().pending === 1)
  await page.evaluate(() => { const f = (window as any).fixture; f.toggle("a"); f.resolve(0) })
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
  const stopped = await snapshot(page)
  assert.equal(stopped.pending, 2, "disposed capability wait must not start synthesis")
  assert.deepEqual(stopped.aborted, [true, true])
  assert.equal(stopped.audios.length, 0)
}))

test("a retained action cannot start synthesis after its view unmounts", () => withPage(async page => {
  await page.evaluate(() => {
    const f = (window as any).fixture
    f.mount("a", "removed")
    void f.toggleAfterRemove("a")
  })
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)))
  const stopped = await snapshot(page)
  assert.equal(stopped.pending, 0)
  assert.equal(stopped.audios.length, 0)
}))

test("buffered playback uses the binary route without newer AbortSignal methods", () => withPage(async page => {
  await page.route("**/api/speech/synthesize/stream", route => route.fulfill({
    status: 200, contentType: "audio/mpeg", body: Buffer.from([97]),
  }))
  await page.evaluate(() => {
    const f = (window as any).fixture
    f.useRealTransport()
    f.mount("a", "buffered")
    Object.defineProperty(AbortSignal, "any", { value: undefined, configurable: true })
    Object.defineProperty(AbortSignal.prototype, "throwIfAborted", { value: undefined, configurable: true })
    f.toggle("a")
  })
  await state(page, "a", "playing")
  await page.evaluate(() => (window as any).fixture.toggle("a"))
  await state(page, "a", "idle")
  assert.deepEqual((await snapshot(page)).revoked, ["blob:speech-1"])
}))

for (const classic of [false, true]) test(`${classic ? "Classic" : "manual"} synthesis 401 leaves the delayed pairing check alive without AbortSignal.any`, () => withPage(async page => {
  await page.route("**/api/speech/synthesize/stream", route => route.fulfill({ status: 401, json: { error: "Expired" } }))
  let release!: () => void
  const afterPlayback = new Promise<void>(resolve => { release = resolve })
  await page.route("**/api/auth/status", async route => {
    await afterPlayback
    await route.fulfill({ json: { authenticated: false, pairingRequired: true } })
  })
  await page.evaluate(classic => {
    const f = (window as any).fixture
    f.useRealTransport()
    Object.defineProperty(AbortSignal, "any", { value: undefined, configurable: true })
    if (classic) f.startClassic()
    else { f.mount("a", "auth"); f.toggle("a") }
  }, classic)
  if (classic) await page.waitForFunction(() => (window as any).fixture.classicFailed())
  else await state(page, "a", "idle")
  release()
  await page.waitForFunction(() => (window as any).fixture.authRequired())
  assert.equal((await snapshot(page)).audios.length, 0)
}))
