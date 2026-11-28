import assert from "node:assert/strict"
import { before, after, test } from "node:test"
import { chromium, type Browser, type Page } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
    name: "live-voice-audio",
    routes: [{ path: "/fixture", html: '<html><body><script type="module" src="/tests/browser/fixtures/live-voice-audio.tsx"></script></body></html>' }],
  })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

type BrowserFixture = {
  info: { input: string[]; requested: boolean; stopped: boolean; started: boolean; rejected: boolean; error: string }
  stop: () => void
  allowStream: () => void
  unavailable: () => string | undefined
  busy: () => Promise<boolean>
  play: (itemId?: string) => void
  interrupt: () => Promise<{ itemId: string; audioEndMs: number }[]>
}
// Evaluations are sent as self-contained callbacks by Playwright.
const start = async (page: Page, path = "") => {
  page.setDefaultTimeout(6_000)
  await page.goto(`${url}${path}`)
  await page.getByRole("button", { name: "Start" }).click()
}

test("synthetic live audio holds the mic, captures PCM, and truncates only rendered output", async () => {
  const page = await browser.newPage()
  try {
    await start(page)
    await page.waitForFunction(() => (window as any).fixture.info.input.length >= 2)
    await page.evaluate(() => (window as any).fixture.play())
    await page.waitForFunction(() => (window as any).fixture.info.rendered > 0)
    const result = await page.evaluate(async () => {
      const fixture: BrowserFixture = (window as any).fixture
      const busy = await fixture.busy()
      const first = fixture.interrupt()
      fixture.play("second")
      const second = fixture.interrupt()
      const [played, replaced] = await Promise.all([first, second])
      const empty = await fixture.interrupt()
      const input = fixture.info.input
      fixture.stop()
      return { input, busy, played, replaced, empty }
    })
    assert.ok(result.busy)
    const pcm = Buffer.from(result.input[1], "base64")
    assert.equal(pcm.length, 640)
    assert.ok(pcm.some(sample => sample !== 0))
    assert.equal(result.played[0]?.itemId, "first")
    assert.ok(result.played[0].audioEndMs > 0 && result.played[0].audioEndMs < 500)
    assert.equal(result.replaced[0]?.itemId, "second")
    assert.deepEqual(result.empty, [])
    await page.waitForFunction(() => (window as any).fixture.info.stopped && !(window as any).fixture.info.error)
    await page.waitForFunction(async () => !await (window as any).fixture.busy())
  } finally { await page.close() }
})

test("muting withholds captured frames while playback runs and resumes the same capture", async () => {
  const page = await browser.newPage()
  try {
    await start(page)
    await page.waitForFunction(() => (window as any).fixture.info.input.length >= 2 && (window as any).fixture.level(false) > 0)
    const count = await page.evaluate(() => {
      const fixture = (window as any).fixture
      fixture.mute(true)
      fixture.play()
      return fixture.info.input.length
    })
    await page.waitForFunction(() => {
      const { info, level } = (window as any).fixture
      return info.playing && level(true) > 0 && info.rendered > 0
    })
    assert.ok(await page.evaluate(() => (window as any).fixture.busy()))
    await page.waitForFunction(() => !(window as any).fixture.info.playing)
    assert.deepEqual(await page.evaluate(() => {
      const { info, level } = (window as any).fixture
      return { frames: info.input.length, requests: info.requests, micLevel: level(false) }
    }), { frames: count, requests: 1, micLevel: 0 })
    await page.evaluate(() => (window as any).fixture.mute(false))
    await page.waitForFunction(count => (window as any).fixture.info.input.length > count + 2 && (window as any).fixture.level(false) > 0, count)
    assert.equal(await page.evaluate(() => (window as any).fixture.info.requests), 1)
  } finally { await page.close() }
})

test("muting OpenAI keeps the audio clock running with zero PCM instead of microphone samples", async () => {
  const page = await browser.newPage()
  try {
    await start(page, "?openai")
    await page.waitForFunction(() => (window as any).fixture.info.input.some((pcm: string) => /[^\0]/.test(atob(pcm))))
    const from = await page.evaluate(() => {
      const fixture = (window as any).fixture
      fixture.mute(true)
      return fixture.info.input.length
    })
    await page.waitForFunction(from => (window as any).fixture.info.input.length >= from + 5, from)
    const { frames, unmutedAt } = await page.evaluate(from => {
      const fixture = (window as any).fixture
      const frames = fixture.info.input.slice(from)
      fixture.mute(false)
      return { frames, unmutedAt: from + frames.length }
    }, from)
    for (const pcm of frames) assert.deepEqual(Buffer.from(pcm, "base64"), Buffer.alloc(960))
    await page.waitForFunction(from => (window as any).fixture.info.input.slice(from)
      .some((pcm: string) => /[^\0]/.test(atob(pcm))), unmutedAt)
    assert.equal(await page.evaluate(() => (window as any).fixture.info.requests), 1)
  } finally { await page.close() }
})

test("stopping while permission is pending keeps the lease until the late stream is stopped", async () => {
  const page = await browser.newPage()
  try {
    await start(page, "?late")
    await page.waitForFunction(() => (window as any).fixture.info.requested)
    assert.ok(await page.evaluate(async () => {
      const fixture: BrowserFixture = (window as any).fixture
      fixture.stop()
      return fixture.busy()
    }))
    await page.waitForFunction(() => { (window as any).fixture.allowStream(); return (window as any).fixture.info.rejected })
    assert.deepEqual(await page.evaluate(() => {
      const { started, stopped, input } = (window as any).fixture.info
      return { started, stopped, input }
    }), { started: false, stopped: true, input: [] })
    await page.waitForFunction(async () => !await (window as any).fixture.busy())
  } finally { await page.close() }
})

test("Tauri Linux remote window reports the native-stream limitation without opening the microphone", async () => {
  const page = await browser.newPage()
  try {
    await page.addInitScript(() => {
      Object.assign(window, { __CODENOMAD_RUNTIME_HOST__: "tauri", __CODENOMAD_WINDOW_CONTEXT__: "remote" })
      Object.defineProperty(navigator, "userAgent", { value: "Linux" })
    })
    await start(page)
    await page.waitForFunction(() => (window as any).fixture.info.rejected)
    assert.deepEqual(await page.evaluate(() => {
      const fixture: BrowserFixture = (window as any).fixture
      return { reason: fixture.unavailable(), requested: fixture.info.requested }
    }), { reason: "remoteWebKit", requested: false })
  } finally { await page.close() }
})

test("Tauri Linux local capture uses a leased frame and removes it when the document leaves", async () => {
  const page = await browser.newPage()
  try {
    await page.addInitScript(() => {
      const calls: { action: string; id: string }[] = []
      Object.assign(window, {
        __CODENOMAD_RUNTIME_HOST__: "tauri", __CODENOMAD_WINDOW_CONTEXT__: "local", calls,
        __TAURI_INTERNALS__: {
          metadata: { currentWindow: { label: "local-fixture" }, currentWebview: { label: "local-fixture" } },
          async invoke(command: string, { request }: { request: { action: string; id: string } }) {
            if (command !== "device_speech_request") throw new Error(command)
            calls.push(request)
            return { ok: true, value: { busy: null } }
          },
        },
      })
      Object.defineProperty(navigator, "userAgent", { value: "Linux" })
    })
    await start(page)
    await page.waitForFunction(() => (window as any).fixture.info.input.length > 0)
    assert.equal(await page.locator("iframe").count(), 1)
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")))
    await page.waitForFunction(() => (window as any).calls.length === 4)
    assert.equal(await page.locator("iframe").count(), 0)
    const { stopped, calls } = await page.evaluate(() => ({ stopped: (window as any).fixture.info.stopped,
      calls: (window as any).calls as { action: string; id: string; purpose?: string }[] }))
    assert.equal(stopped, true)
    assert.deepEqual(calls.map(call => call.action), ["claimMicrophone", "authorizeApiMicrophone", "revokeApiMicrophone", "releaseMicrophone"])
    assert.equal(calls[0].purpose, "conversation")
    assert.ok(calls.every(call => call.id === calls[0].id))
  } finally { await page.close() }
})

test("Electron microphone denial releases its native lease without requesting browser audio", async () => {
  const page = await browser.newPage()
  try {
    await page.addInitScript(() => {
      const calls: string[] = []
      Object.assign(window, {
        calls,
        electronAPI: {
          async deviceSpeech({ action }: { action: string }) {
            calls.push(action)
            return { ok: true, value: { busy: null } }
          },
          async requestMicrophoneAccess() { calls.push("access"); return { granted: false } },
        },
      })
    })
    await start(page)
    await page.waitForFunction(() => (window as any).fixture.info.rejected || (window as any).fixture.info.started)
    assert.deepEqual(await page.evaluate(() => ({
      calls: (window as any).calls,
      requested: (window as any).fixture.info.requested,
      rejected: (window as any).fixture.info.rejected,
    })), { calls: ["claimMicrophone", "access", "releaseMicrophone"], requested: false, rejected: true })
  } finally { await page.close() }
})
