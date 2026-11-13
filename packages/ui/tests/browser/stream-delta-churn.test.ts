import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser, type Page } from "playwright"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { fixtureEventStream } from "./fixture-event-stream"

let browser: Browser, url: string
let stream: Awaited<ReturnType<typeof fixtureEventStream>>
before(async () => {
  const fixture = await borrowFixture({
    name: "stream-delta-churn",
    routes: [
      { path: "/fixture", html: "<html><body><div id=\"root\" style=\"display:flex;width:1100px;height:740px\"></div><script type=\"module\" src=\"/tests/browser/fixtures/stream-delta-churn.tsx\"></script></body></html>" },
      { path: "/actions", html: '<html><body><div id="root" style="width:1100px"></div><script type="module" src="/tests/browser/fixtures/stream-action-state.tsx"></script></body></html>' },
    ],
  })
  url = fixture.url
  stream = await fixtureEventStream(url)
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { try { await browser?.close() } finally { await stream?.close() } })

async function withPage(run: (page: Page) => Promise<void>, actions = false) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()) })
  page.on("response", response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
  page.on("requestfailed", request => errors.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`))
  let speechAvailable = true
  await page.route("**/*", route => {
    const request = new URL(route.request().url())
    if (request.hostname !== "127.0.0.1") return route.abort()
    if (request.pathname === "/workspaces/stream-delta-fixture/yolo/sessions/active" && route.request().method() === "GET") {
      return route.fulfill({ json: { enabled: false } })
    }
    if (request.pathname.endsWith("/speech/capabilities")) return route.fulfill({ json: {
      available: speechAvailable, configured: true, provider: "fixture", supportsStt: false, supportsTts: true,
      supportsStreamingTts: true, ttsFormats: ["mp3"], streamingTtsFormats: ["mp3"], ttsConfigured: true,
    } })
    if (request.pathname.endsWith("/session-history/outline")) return route.abort()
    if (request.pathname.startsWith("/api/")) return route.fulfill({ json: {} })
    return route.continue()
  })
  try {
    await stream.route(page)
    await page.exposeFunction("setSpeechAvailable", (available: boolean) => { speechAvailable = available })
    const opened = page.waitForResponse(response => new URL(response.url()).pathname === "/api/events")
    await page.goto(actions ? url.replace(/\/fixture$/, "/actions") : url, { waitUntil: "domcontentloaded" })
    assert.match((await opened).headers()["content-type"], /text\/event-stream/)
    await page.waitForFunction(actions => Boolean(actions ? (window as any).streamActionState : (window as any).streamDeltaFixture), actions)
    await run(page)
    assert.deepEqual(errors, [], "page errors")
  } finally {
    await page.close()
  }
}

test("a text delta does not replace action-group buttons of a settled reply", async () => {
  await withPage(async page => {
    const ids = await page.evaluate(() => (window as any).streamDeltaFixture.seed())
    await page.waitForFunction(({ settled, streaming }) => settled.every((id: string) =>
      document.querySelectorAll(`[data-message-id="${id}"] .message-action-group button`).length > 0)
      && document.querySelector(`[data-message-id="${streaming}"] .markdown-body`)?.textContent?.trim().length === 39 * 80, ids)
    await page.evaluate(({ settled, streaming }) => {
      const groups = settled.map((id: string) => document.querySelector(`[data-message-id="${id}"] .message-action-group`)!)
      const buttons = groups.flatMap((group: Element) => [...group.querySelectorAll("button")])
      let mutations = 0
      const observer = new MutationObserver(records => { mutations += records.length })
      for (const group of groups) observer.observe(group, { subtree: true, childList: true })
      ;(window as any).finishChurnProbe = () => {
        mutations += observer.takeRecords().length
        observer.disconnect()
        return { mutations, retained: buttons.every((button: Element) => button.isConnected)
          && groups.every((group: Element, index: number) => group === document.querySelector(`[data-message-id="${settled[index]}"] .message-action-group`)) }
      }
      ;(window as any).streamDeltaFixture.delta(streaming)
    }, ids)
    await page.waitForFunction(id => document.querySelector(`[data-message-id="${id}"] .markdown-body`)?.textContent?.trim().length === 40 * 80, ids.streaming)
    const result = await page.evaluate(() => (window as any).finishChurnProbe())
    assert.equal(result.retained, true, "the original mounted controls remain connected")
    assert.equal(result.mutations, 0, "a streaming delta must not replace settled action controls")
  })
})

test("action eligibility updates when its values change", async () => withPage(async page => {
  const change = (method: string, value?: unknown) => page.evaluate(([method, value]) => (window as any).streamActionState[method as string](value), [method, value])
  const has = (label: string, expected = true) => page.waitForFunction(({ label, expected }) =>
    Boolean(document.querySelector(`.message-action-group button[aria-label="${label}"]`)) === expected, { label, expected })
  await change("capabilities")
  await has("Fork after this message")
  await change("record", { isEphemeral: true }); await has("Fork after this message", false)
  await change("record", { isEphemeral: false, status: "streaming" }); await has("Fork after this message", false)
  await change("record", { status: "error" }); await has("Fork after this message", false)
  await change("completed", 12); await has("Fork after this message")
  await change("completed"); await has("Fork after this message", false)
  await change("record", { status: "complete" }); await has("Fork after this message")
  await change("technical", ["tool", "reasoning"]); await has("Remove tools and reasoning from this response")
  await change("technical", []); await has("Remove tools and reasoning from this response", false)
  await change("text", ""); await has("Copy", false); await has("Speak message", false)
  await change("text", " \n\t "); await has("Copy", false); await has("Speak message", false)
  await change("text", "current text"); await has("Copy"); await has("Speak message")
  await page.evaluate(() => (window as any).setSpeechAvailable(false)); await change("capabilities"); await has("Speak message", false)
  await page.evaluate(() => (window as any).setSpeechAvailable(true)); await change("capabilities"); await has("Speak message")
  await change("record", { role: "user", status: "sending" }); await has("Copy", false); await has("Fork after this message", false)
  await change("pending", { id: "pending", delivery: "queue" }); await has("Edit queued prompt")
  await change("pending"); await change("record", { status: "complete" }); await has("Copy"); await has("Fork after this message")
}, true))
