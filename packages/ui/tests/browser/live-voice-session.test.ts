import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { after, before, test } from "node:test"
import { chromium, type Browser, type WebSocketRoute } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

const pcm = Buffer.alloc(24_000).toString("base64")
let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
    name: "live-voice-session",
    routes: [{ path: "/fixture", html: '<html><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/live-voice-session.tsx"></script></body></html>' }],
  })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

async function fixture(engine: "gemini" | "openai" = "gemini") {
  const page = await browser.newPage()
  page.setDefaultTimeout(8_000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/api/**", route => route.fulfill(route.request().url().endsWith("/api/events")
    ? { contentType: "text/event-stream", body: ": ready\n\n" }
    : { contentType: "application/json", body: "{}" }))
  const sent: any[] = []
  const events = new EventEmitter()
  const waitForSent = (predicate: (item: any) => boolean) => {
    const existing = sent.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => { events.off("sent", listener); reject(new Error("Missing client voice event")) }, 8_000)
      function listener(item: any) {
        if (!predicate(item)) return
        clearTimeout(timeout)
        events.off("sent", listener)
        resolve(item)
      }
      events.on("sent", listener)
    })
  }
  let opened: (socket: WebSocketRoute) => void, close: () => void
  const socket = new Promise<WebSocketRoute>(resolve => { opened = resolve })
  const closed = new Promise<void>(resolve => { close = resolve })
  let opens = 0
  await page.routeWebSocket("**/api/speech/conversation/live?engine=*", ws => {
    opens++
    ws.onMessage(message => {
      const value = JSON.parse(String(message))
      sent.push(value)
      events.emit("sent", value)
    })
    ws.onClose(() => close())
    opened(ws)
  })
  await page.goto(`${url}${engine === "openai" ? "?openai" : ""}`)
  const snapshot = () => page.evaluate(() => {
    const f = (window as any).fixture
    return { info: f.info, state: f.state(), transcript: f.transcript(), draft: f.draft(), userTexts: f.userTexts() }
  })
  async function start() {
    await page.getByRole("button", { name: "Start" }).click()
    assert.equal((await snapshot()).state.phase, "consent")
    assert.equal((await snapshot()).info.capture, 0)
    assert.equal(opens, 0)
    await page.getByRole("button", { name: "Accept" }).click()
    const ws = await socket
    const send = (message: object) => ws.send(JSON.stringify(message))
    assert.equal((await snapshot()).info.capture, 1)
    await waitForSent(item => item.type === "start")
    assert.deepEqual(sent, [{ type: "start", context: {
      project: "Project", branch: "", worktree: "", title: "Conversation", status: "idle",
    } }])
    send({ type: "ready", inputRate: engine === "openai" ? 24_000 : 16_000, outputRate: 24_000 })
    await page.waitForFunction(() => (window as any).fixture.state().phase === "live")
    return send
  }
  return { page, start, sent, closed, errors, snapshot, waitForSent }
}

test("Gemini consent gates capture and connection; the real send and dock keep the draft", async () => {
  const { page, start, sent, closed, errors, snapshot, waitForSent } = await fixture()
  try {
    const send = await start()
    send({ type: "transcript", role: "user", text: "Hello ", final: false })
    send({ type: "transcript", role: "assistant", text: "Hi", final: false })
    send({ type: "transcript", role: "user", text: "agent", final: true })
    send({ type: "turn-complete" })
    send({ type: "tool-call", id: "reply", name: "get_last_reply", arguments: {} })
    const call = { type: "tool-call", id: "one", name: "send_to_agent", arguments: { text: "Ask the agent" } }
    send(call); send(call)
    await page.locator(".interruption-dock").waitFor()
    await page.waitForFunction(() => (window as any).fixture.info.prompts.length === 1)
    assert.equal((await snapshot()).info.prompts[0].sessionID, "voice")
    assert.equal((await snapshot()).info.prompts[0].delivery, "steer")
    assert.equal((await snapshot()).draft, "Unsent draft")
    assert.deepEqual((await snapshot()).userTexts.map((part: any) => part.text), ["Ask the agent"])
    assert.deepEqual((await snapshot()).transcript.map((row: any) => [row.role, row.text, row.final]), [
      ["user", "Hello agent", true], ["assistant", "Hi", true],
    ])
    assert.equal((await waitForSent(item => item.id === "reply")).output, '{"text":"Visible answer"}')
    await waitForSent(item => item.id === "one")
    assert.equal(sent.filter(item => item.id === "one").length, 1)
    send({ type: "tool-call", id: "status", name: "get_session_status", arguments: {} })
    assert.equal(JSON.parse((await waitForSent(item => item.id === "status")).output).status, "waiting_permission")
    await page.getByRole("button", { name: "Next request" }).click()
    await page.getByText("Which approach?").waitFor()
    await page.getByRole("button", { name: "Close", exact: true }).click()
    await closed
    await page.waitForFunction(() => (window as any).fixture.info.released === 1)
    assert.deepEqual((await snapshot()).transcript, [])
    assert.deepEqual(errors, [])
  } finally { await page.close() }
})

test("Gemini cancellation and target changes fence calls through native admission", async () => {
  const { page, start, sent, closed, snapshot } = await fixture()
  try {
    const send = await start()
    await page.evaluate(() => (window as any).fixture.holdAdmission())
    const call = (id: string) => ({ type: "tool-call", id, name: "send_to_agent", arguments: { text: "Must not send" } })
    send({ type: "tool-cancel", id: "early" })
    send(call("early"))
    send(call("held"))
    await page.waitForFunction(() => (window as any).fixture.waitingAdmission())
    send({ type: "tool-cancel", id: "held" })
    send({ type: "transcript", role: "user", text: "Cancelled", final: true })
    await page.waitForFunction(() => (window as any).fixture.transcript().length === 1)
    await page.evaluate(() => (window as any).fixture.releaseAdmission())
    send(call("target"))
    await page.waitForFunction(() => (window as any).fixture.waitingAdmission())
    await page.evaluate(() => {
      const f = (window as any).fixture
      f.switchSession()
      f.releaseAdmission()
    })
    await closed
    await page.waitForFunction(() => (window as any).fixture.info.released === 1)
    assert.deepEqual((await snapshot()).info.prompts, [])
    assert.deepEqual(sent.filter(item => item.type === "tool-result"), [])
    assert.equal((await snapshot()).state.phase, "closed")
  } finally { await page.close() }
})

test("OpenAI final text replaces deltas; unknown tools fail closed", async () => {
  const { page, start, closed, snapshot, waitForSent } = await fixture("openai")
  try {
    const send = await start()
    send({ type: "transcript", role: "user", text: "Hel", final: false, itemId: "user" })
    send({ type: "transcript", role: "user", text: "Hello", final: true, replace: true, itemId: "user" })
    send({ type: "audio", pcm, itemId: "assistant", contentIndex: 0 })
    send({ type: "interrupted" })
    const truncate = await waitForSent(item => item.type === "truncate")
    assert.equal(truncate?.itemId, "assistant")
    assert.ok(truncate.audioEndMs >= 0 && truncate.audioEndMs < 500)
    await page.evaluate(() => (window as any).fixture.busy())
    send({ type: "tool-call", id: "queued", name: "send_to_agent", arguments: { text: "Queue this prompt" } })
    assert.equal((await waitForSent(item => item.id === "queued")).output, '{"delivery":"queued"}')
    assert.equal((await snapshot()).info.prompts[0].delivery, "queue")
    send({ type: "tool-call", id: "bad", name: "read_file", arguments: { path: "/denied" } })
    await closed
    await page.waitForFunction(() => (window as any).fixture.info.released === 1)
    const result = await snapshot()
    assert.equal(result.state.reason, "invalid-message")
    assert.equal(result.transcript[0].text, "Hello")
    assert.deepEqual(result.info.prompts.map((item: any) => item.text), ["Queue this prompt"])
  } finally { await page.close() }
})

test("the client stops a silent active conversation even when its socket stays open", async () => {
  const { page, start, closed, snapshot } = await fixture()
  try {
    await page.clock.install()
    const send = await start()
    send({ type: "transcript", role: "assistant", text: "Assistant speech does not renew the timer.", final: true })
    await page.waitForFunction(() => (window as any).fixture.transcript().length === 1)
    await page.clock.fastForward(120_100)
    await closed
    assert.equal((await snapshot()).state.reason, "idle")
    assert.equal((await snapshot()).info.released, 1)
  } finally { await page.close() }
})
