import assert from "node:assert/strict"
import { EventEmitter, once } from "node:events"
import { after, before, test } from "node:test"
import { chromium, type Browser, type WebSocketRoute } from "playwright"
import { LIVE_VOICE_ABSOLUTE_MS, LIVE_VOICE_IDLE_MS } from "../../../server/src/speech/live-voice-contract"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

const pcm = Buffer.alloc(24_000).toString("base64")
let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
    name: "live-voice-session",
    routes: [{ path: "/fixture", html: '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/browser/fixtures/live-voice-session.tsx"></script></body></html>' }],
  })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

async function fixture(engine: "gemini" | "openai" = "gemini", interactive = false, hebrew = false, title?: string) {
  const context = await browser.newContext(interactive ? { viewport: { width: hebrew ? 320 : 400, height: 600 } } : {})
  armFixtureNavigationBudget(context)
  const page = await context.newPage()
  page.setDefaultTimeout(8_000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  const config = {
    speech: { hasApiKey: true, ttsVoice: "sample", ttsFormat: "mp3", playbackMode: "buffered" },
    voiceConversation: {
      geminiLive: { hasApiKey: true, model: "test-gemini", voice: "Puck" },
      openaiRealtime: { hasApiKey: true, model: "test-openai", voice: "marin" },
    },
  }
  await page.context().route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname
    if (path === "/api/events") return route.fulfill({ contentType: "text/event-stream", body: ": ready\n\n" })
    return route.fulfill({ json: interactive && path.endsWith("/config/server") ? config : {} })
  })
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
    events.emit("socket", ws)
  })
  const destination = new URL(url)
  if (engine === "openai") destination.searchParams.set("openai", "")
  if (interactive) destination.searchParams.set("ui", "")
  if (hebrew) destination.searchParams.set("he", "")
  if (title) destination.searchParams.set("title", title)
  await page.goto(destination.href, { waitUntil: "domcontentloaded" })
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
  const consent = page.locator(".live-voice-consent")
  const live = page.locator("#live-voice-conversation")
  async function openConsent() {
    await page.locator(".prompt-actions-menu-trigger").click()
    await page.locator('[data-action-key="conversation"]').click()
    await consent.waitFor()
  }
  async function acceptConsent() {
    await consent.locator(".button-primary").click()
    const ws = await socket
    await waitForSent(item => item.type === "start")
    const send = (message: object) => ws.send(JSON.stringify(message))
    send({ type: "ready", inputRate: engine === "gemini" ? 16_000 : 24_000, outputRate: 24_000 })
    await live.getByText("Listening", { exact: true }).waitFor()
    return send
  }
  return { page, context, start, sent, closed, errors, snapshot, waitForSent, socket, opens: () => opens,
    nextSocket: async () => (await once(events, "socket", { signal: AbortSignal.timeout(8_000) }))[0] as WebSocketRoute,
    consent, live, openConsent, acceptConsent }
}

test("Gemini consent gates capture and connection; the real send and dock keep the draft", async () => {
  const { page, context, start, sent, closed, errors, snapshot, waitForSent } = await fixture()
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
      ["user", "Hello agent", true], ["assistant", "Hi", true], ["sent", "Ask the agent", true],
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
  } finally { await context.close() }
})

test("Gemini cancellation and target changes fence calls through native admission", async () => {
  const { page, context, start, sent, closed, snapshot } = await fixture()
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
  } finally { await context.close() }
})

for (const [order, description] of [
  ["early", "queues once the first prompt starts work"],
  ["late", "queues after native acceptance even before execution starts"],
  ["cancelled", "starts on idle after the first call is cancelled"],
  ["failed", "starts on idle after the first prompt fails"],
] as const) {
  test(`a waiting voice send ${description}`, async () => {
    const { page, context, start, snapshot, waitForSent } = await fixture()
    try {
      const send = await start()
      if (order === "late" || order === "failed") {
        await page.evaluate(value => (window as any).fixture.setFirstPrompt(value), order === "late" ? "delay" : "fail")
      }
      await page.evaluate(() => (window as any).fixture.holdAdmission())
      const call = (id: string) => ({ type: "tool-call", id, name: "send_to_agent", arguments: { text: id } })
      const readStatus = async (id: string) => {
        send({ type: "tool-call", id, name: "get_session_status", arguments: {} })
        return JSON.parse((await waitForSent(item => item.id === id)).output).status
      }
      send(call("first"))
      await page.waitForFunction(() => (window as any).fixture.waitingAdmission())
      send(call("second"))
      const cancelled = order === "cancelled"
      if (cancelled) send({ type: "tool-cancel", id: "first" })
      assert.equal(await readStatus("before"), "idle")
      assert.deepEqual((await snapshot()).info.prompts, [])
      await page.evaluate(() => (window as any).fixture.releaseAdmission(false))
      const busy = order === "early" || order === "late"
      assert.deepEqual(JSON.parse((await waitForSent(item => item.id === "second")).output),
        { delivery: busy ? "queued" : "submitted" })
      assert.deepEqual((await snapshot()).info.prompts.map((item: any) => [item.text, item.delivery, item.resume]),
        [...(cancelled ? [] : [["first", "steer", undefined]]), ["second", busy ? "queue" : "steer", busy ? false : undefined]])
      if (order === "late") {
        assert.equal(await readStatus("delayed"), "idle")
        await page.evaluate(() => (window as any).fixture.startExecution())
        assert.equal(await readStatus("started"), "running")
        await page.evaluate(() => (window as any).fixture.finishExecution())
        assert.equal(await readStatus("finished"), "idle")
        send(call("after-idle"))
        assert.deepEqual(JSON.parse((await waitForSent(item => item.id === "after-idle")).output), { delivery: "submitted" })
        assert.equal((await snapshot()).info.prompts.at(-1).delivery, "steer")
      }
    } finally { await context.close() }
  })
}

for (const recovery of ["reconnect", "expiry"] as const) {
  test(`a lost voice execution start stops parking prompts after ${recovery}`, async () => {
    const { page, context, start, snapshot, waitForSent } = await fixture()
    try {
      await page.clock.install()
      const send = await start()
      await page.evaluate(() => (window as any).fixture.setFirstPrompt("delay"))
      async function prompt(id: string) {
        send({ type: "tool-call", id, name: "send_to_agent", arguments: { text: id } })
        return JSON.parse((await waitForSent(item => item.id === id)).output).delivery
      }
      assert.equal(await prompt("first"), "submitted")
      if (recovery === "reconnect") {
        assert.deepEqual(await page.evaluate(() => (window as any).fixture.resyncIdle()),
          { known: true, status: "idle", idle: 1 })
      } else {
        await page.clock.fastForward(10_000)
        assert.equal(await prompt("inside-bound"), "queued")
        await page.clock.fastForward(5_100)
      }
      assert.equal(await prompt("after-recovery"), "submitted")
      const last = (await snapshot()).info.prompts.at(-1)
      assert.equal(last.delivery, "steer")
      assert.equal(last.resume, undefined)
    } finally { await context.close() }
  })
}

test("Gemini cancellation while awaiting a native ack still queues the next voice send", async () => {
  const { page, context, start, snapshot, sent, waitForSent } = await fixture()
  try {
    const send = await start()
    await page.evaluate(() => (window as any).fixture.setFirstPrompt("holdAck"))
    const call = (id: string) => ({ type: "tool-call", id, name: "send_to_agent", arguments: { text: id } })
    send(call("first"))
    await page.waitForFunction(() => (window as any).fixture.waitingAck())
    send({ type: "tool-cancel", id: "first" })
    send({ type: "tool-call", id: "status", name: "get_session_status", arguments: {} })
    assert.deepEqual(JSON.parse((await waitForSent(item => item.id === "status")).output), { title: "Conversation", status: "idle" })
    send(call("second"))
    await page.evaluate(() => (window as any).fixture.releaseAck())
    assert.deepEqual(JSON.parse((await waitForSent(item => item.id === "second")).output), { delivery: "queued" })
    assert.deepEqual((await snapshot()).info.prompts.map((item: any) => [item.text, item.delivery]), [["first", "steer"], ["second", "queue"]])
    assert.equal(sent.some(item => item.type === "tool-result" && item.id === "first"), false)
  } finally { await context.close() }
})

test("a voice send acknowledged after reopening still makes the new controller queue", async () => {
  const { page, context, start, closed, snapshot, sent, waitForSent, nextSocket } = await fixture()
  try {
    const send = await start()
    await page.evaluate(() => (window as any).fixture.setFirstPrompt("holdAck"))
    const call = (id: string) => ({ type: "tool-call", id, name: "send_to_agent", arguments: { text: id } })
    send(call("first"))
    await page.waitForFunction(() => (window as any).fixture.waitingAck())
    await page.getByRole("button", { name: "Close", exact: true }).click()
    await closed
    await page.waitForFunction(() => (window as any).fixture.info.released === 1)
    const pending = nextSocket()
    await page.getByRole("button", { name: "Start", exact: true }).click()
    const reopened = await pending
    reopened.send(JSON.stringify({ type: "ready", inputRate: 16_000, outputRate: 24_000 }))
    await page.waitForFunction(() => (window as any).fixture.state().phase === "live")
    reopened.send(JSON.stringify(call("second")))
    await page.evaluate(() => (window as any).fixture.releaseAck())
    assert.deepEqual(JSON.parse((await waitForSent(item => item.id === "second")).output), { delivery: "queued" })
    assert.deepEqual((await snapshot()).info.prompts.map((item: any) => [item.text, item.delivery]), [["first", "steer"], ["second", "queue"]])
    assert.equal(sent.some(item => item.type === "tool-result" && item.id === "first"), false)
  } finally { await context.close() }
})

test("native voice acknowledgement in another displayed session stays bound to the original session", async () => {
  const { page, context, start, closed, snapshot, waitForSent, nextSocket } = await fixture()
  try {
    const send = await start()
    await page.evaluate(() => (window as any).fixture.setFirstPrompt("holdAck"))
    const call = (id: string) => ({ type: "tool-call", id, name: "send_to_agent", arguments: { text: id } })
    send(call("first"))
    await page.waitForFunction(() => (window as any).fixture.waitingAck())
    assert.equal(await page.evaluate(() => (window as any).fixture.acknowledgementSettled()), false)
    await page.evaluate(() => (window as any).fixture.switchSession())
    await closed
    await page.evaluate(() => (window as any).fixture.releaseAck())
    await page.waitForFunction(() => (window as any).fixture.acknowledgementSettled() && (window as any).fixture.info.released === 1)
    await page.evaluate(() => (window as any).fixture.returnSession())
    const pending = nextSocket()
    await page.getByRole("button", { name: "Start", exact: true }).click()
    const socket = await pending
    socket.send(JSON.stringify({ type: "ready", inputRate: 16_000, outputRate: 24_000 }))
    await page.waitForFunction(() => (window as any).fixture.state().phase === "live")
    socket.send(JSON.stringify(call("second")))
    assert.deepEqual(JSON.parse((await waitForSent(item => item.id === "second")).output), { delivery: "queued" })
    assert.deepEqual((await snapshot()).info.prompts.map((item: any) => [item.sessionID, item.text, item.delivery]), [
      ["voice", "first", "steer"], ["voice", "second", "queue"],
    ])
  } finally { await context.close() }
})

test("a typed send queues behind a confirmed voice send before the native start event", async () => {
  const { page, context, openConsent, acceptConsent, waitForSent } = await fixture("gemini", true)
  try {
    await openConsent()
    const send = await acceptConsent()
    await page.evaluate(() => (window as any).fixture.setFirstPrompt("delay"))
    send({ type: "tool-call", name: "send_to_agent", id: "first", arguments: { text: "first" } })
    assert.deepEqual(JSON.parse((await waitForSent(item => item.id === "first")).output), { delivery: "submitted" })
    const field = page.getByRole("textbox").first()
    await field.fill("typed follow-up")
    await field.press("Enter")
    await page.waitForFunction(() => (window as any).fixture.info.prompts.length === 2)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.info.prompts.map((prompt: any) => [prompt.text, prompt.delivery, prompt.resume])),
      [["first", "steer", undefined], ["typed follow-up", "queue", false]])
  } finally { await context.close() }
})

test("a typed prompt appears pending before native instruction sync completes", async () => {
  const { page, context } = await fixture("gemini", true)
  try {
    const field = page.getByRole("textbox").first()
    await field.fill("A typed prompt")
    await page.evaluate(() => (window as any).fixture.holdAdmission())
    await field.press("Enter")
    await page.waitForFunction(() => (window as any).fixture.waitingAdmission())
    assert.equal(await field.inputValue(), "")
    const projected = () => page.evaluate(() => (window as any).fixture.userPrompts())
    const [pending, ...others] = await projected()
    assert.deepEqual(others, [])
    assert.equal(pending?.text, "A typed prompt")
    assert.equal(pending.status, "sending")
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.info.prompts), [])
    await page.evaluate(() => (window as any).fixture.releaseAdmission())
    await page.waitForFunction(() => (window as any).fixture.userPrompts()[0]?.status === "sent")
    assert.deepEqual(await projected(), [{ ...pending, status: "sent" }])
  } finally { await context.close() }
})

test("a later typed send does not demote the voice prompt awaiting admission on an idle session", async () => {
  const { page, context, openConsent, acceptConsent, waitForSent } = await fixture("gemini", true)
  try {
    await openConsent()
    const send = await acceptConsent()
    await page.evaluate(() => {
      const fixture = (window as any).fixture
      fixture.setFirstPrompt("delay")
      fixture.holdAdmission()
    })
    send({ type: "tool-call", name: "send_to_agent", id: "first", arguments: { text: "first" } })
    await page.waitForFunction(() => (window as any).fixture.waitingAdmission())
    const field = page.getByRole("textbox").first()
    await field.fill("typed follow-up")
    await field.press("Enter")
    assert.equal(await field.inputValue(), "")
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.info.prompts), [])
    await page.evaluate(() => (window as any).fixture.releaseAdmission())
    assert.deepEqual(JSON.parse((await waitForSent(item => item.id === "first")).output), { delivery: "submitted" })
    await page.waitForFunction(() => (window as any).fixture.info.prompts.length === 2)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.info.prompts.map((prompt: any) => [prompt.text, prompt.delivery, prompt.resume])),
      [["first", "steer", undefined], ["typed follow-up", "queue", false]])
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.userPrompts().map((prompt: any) => prompt.text)), ["first"])
  } finally { await context.close() }
})

test("get_last_reply reads the latest answer without replacing the displayed history", async () => {
  const { page, context, start, waitForSent } = await fixture()
  try {
    const send = await start()
    await page.evaluate(() => (window as any).fixture.openHistory())
    const history = () => page.evaluate(() => (window as any).fixture.history())
    const before = await history()
    send({ type: "tool-call", name: "get_last_reply", id: "reply", arguments: {} })
    await page.waitForFunction(() => (window as any).fixture.info.historyReads === 1)
    await page.evaluate(() => (window as any).fixture.releaseHistory())
    assert.deepEqual(JSON.parse((await waitForSent(item => item.id === "reply")).output), { text: "Newest answer" })
    assert.deepEqual(await history(), before)
  } finally { await context.close() }
})

test("get_last_reply seeks past a reverted tail without moving history or following a repeated cursor", async () => {
  const { page, context, start, waitForSent } = await fixture()
  try {
    const send = await start()
    await page.evaluate(() => {
      const fixture = (window as any).fixture
      fixture.openHistory()
      fixture.hideLatestPage()
    })
    const history = () => page.evaluate(() => (window as any).fixture.history())
    const before = await history()
    for (const [id, text] of [["visible", "Last answer still visible"], ["repeated", ""]] as const) {
      await page.evaluate(repeated => (window as any).fixture.hideLatestPage(repeated), id === "repeated")
      send({ type: "tool-call", name: "get_last_reply", id, arguments: {} })
      assert.deepEqual(JSON.parse((await waitForSent(item => item.id === id)).output), { text })
      assert.deepEqual(await page.evaluate(() => (window as any).fixture.info.historyCursors), [null, "older-visible"])
      assert.deepEqual(await history(), before)
    }
  } finally { await context.close() }
})

test("get_recent_errors reads the latest failures without replacing the displayed history", async () => {
  const { page, context, start, waitForSent } = await fixture()
  try {
    const send = await start()
    const failure = "Agent provider rate limit reached"
    await page.evaluate(message => (window as any).fixture.openHistory(message), failure)
    const history = () => page.evaluate(() => (window as any).fixture.history())
    const before = await history()
    assert.equal(before.kind, "history")
    send({ type: "tool-call", name: "get_recent_errors", id: "errors", arguments: {} })
    await page.waitForFunction(() => (window as any).fixture.info.historyReads === 1)
    await page.evaluate(() => (window as any).fixture.releaseHistory())
    assert.deepEqual(JSON.parse((await waitForSent(item => item.id === "errors")).output), { errors: [failure] })
    assert.deepEqual(await history(), before)
  } finally { await context.close() }
})

test("voice sends from an older page await the latest window and recheck the target", async () => {
  for (const switchTarget of [false, true]) {
    const { page, context, start, closed, snapshot, waitForSent } = await fixture()
    try {
      const send = await start()
      await page.evaluate(() => (window as any).fixture.openHistory())
      const history = () => page.evaluate(() => (window as any).fixture.history())
      const before = await history()
      assert.equal(before.kind, "history")
      assert.equal(before.ids.length, 200)
      send({ type: "tool-call", id: "send", name: "send_to_agent", arguments: { text: "From history" } })
      await page.waitForFunction(() => (window as any).fixture.info.historyReads === 1)
      assert.deepEqual(await history(), before)
      assert.deepEqual((await snapshot()).info.prompts, [])
      if (switchTarget) {
        await page.evaluate(() => (window as any).fixture.switchSession())
        await closed
      }
      await page.evaluate(() => (window as any).fixture.releaseHistory())
      await page.waitForFunction(() => (window as any).fixture.history().kind === "latest")
      if (switchTarget) {
        assert.deepEqual((await snapshot()).info.prompts, [])
        assert.deepEqual((await history()).ids, ["latest-assistant"])
      } else {
        assert.deepEqual(JSON.parse((await waitForSent(item => item.id === "send")).output), { delivery: "submitted" })
        const [prompt] = (await snapshot()).info.prompts
        assert.equal(prompt.text, "From history")
        assert.deepEqual((await history()).ids, ["latest-assistant", prompt.id])
      }
    } finally { await context.close() }
  }
})

test("starting dictation aborts a pending Classic summary and suppresses its late playback", async () => {
  const { page, context } = await fixture("gemini", true)
  try {
    await page.waitForFunction(() => Boolean((window as any).fixture?.holdClassicSummary))
    await page.evaluate(() => (window as any).fixture.holdClassicSummary())
    const more = page.locator(".prompt-actions-menu-trigger")
    await more.click()
    const conversation = page.getByRole("menuitemcheckbox", { name: "Conversation mode", exact: true })
    const dictation = page.getByRole("menuitemcheckbox", { name: "Dictation mode", exact: true })
    await conversation.click()
    await more.click()
    assert.equal(await conversation.getAttribute("aria-checked"), "true")
    assert.equal(await dictation.isDisabled(), true)
    await page.keyboard.press("Escape")
    await page.evaluate(() => (window as any).classic.emitSummary())
    await page.waitForFunction(() => (window as any).classic.probe.requested)
    await more.click()
    await conversation.click()
    await more.click()
    await dictation.click()
    await more.click()
    assert.equal(await dictation.getAttribute("aria-checked"), "true")
    assert.equal(await conversation.isDisabled(), true)
    await page.keyboard.press("Escape")
    await page.locator(".voice-button").hover()
    await page.mouse.down()
    await page.waitForFunction(() => (window as any).fixture.info.capture === 1)
    const result = await page.evaluate(async () => {
      const probe = (window as any).classic.probe
      probe.release()
      await new Promise(requestAnimationFrame)
      return { aborted: probe.aborted, played: probe.played }
    })
    assert.deepEqual(result, { aborted: true, played: 0 })
  } finally { await context.close() }
})

test("Classic holds new summaries until the API input test releases the microphone", async () => {
  const { page, context } = await fixture("gemini", true)
  try {
    const recording = await context.newPage()
    await recording.addInitScript(() => {
      window.__CODENOMAD_WINDOW_CONTEXT__ = "preferences"
      Object.assign(window, { electronAPI: { deviceSpeech: async ({ action }: { action: string }) => ({
        ok: true, value: action === "claimMicrophone" ? { busy: null } : { engine: "api" },
      }) } })
    })
    await recording.goto(page.url(), { waitUntil: "domcontentloaded" })
    await recording.waitForFunction(() => Boolean((window as any).fixture?.openVoiceSettings))
    await recording.evaluate(() => (window as any).fixture.openVoiceSettings())

    await page.waitForFunction(() => Boolean((window as any).fixture?.holdClassicSummary))
    await page.evaluate(() => (window as any).fixture.holdClassicSummary())
    const more = page.locator(".prompt-actions-menu-trigger")
    await more.click()
    await page.getByRole("menuitemcheckbox", { name: "Conversation mode", exact: true }).click()
    await recording.getByRole("button", { name: "Test API input", exact: true }).click()
    await recording.getByRole("button", { name: "Stop recording", exact: true }).waitFor()

    const probe = await page.evaluate(async () => {
      const { classic } = window as any
      classic.emitSummary()
      await new Promise(requestAnimationFrame)
      return { requested: classic.probe.requested, played: classic.probe.played }
    })
    assert.deepEqual(probe, { requested: false, played: 0 })
    assert.equal(await recording.evaluate(() => (window as any).fixture.info.released), 0)

    await recording.getByRole("button", { name: "Stop recording", exact: true }).click()
    await recording.waitForFunction(() => (window as any).fixture.info.released === 1)
    await page.waitForFunction(() => (window as any).classic.probe.requested)
    await page.evaluate(() => (window as any).classic.probe.release())
    await page.waitForFunction(() => (window as any).classic.probe.played === 1)
  } finally { await context.close() }
})

test("OpenAI final text replaces deltas; unknown tools fail closed", async () => {
  const { page, context, start, closed, snapshot, waitForSent } = await fixture("openai")
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
    send({ type: "tool-call", id: "queued", responseId: "queue-reply", name: "send_to_agent", arguments: { text: "Queue this prompt" } })
    assert.equal((await waitForSent(item => item.id === "queued")).output, '{"delivery":"queued"}')
    assert.equal((await snapshot()).info.prompts[0].delivery, "queue")
    send({ type: "tool-call", id: "bad", name: "read_file", arguments: { path: "/denied" } })
    await closed
    await page.waitForFunction(() => (window as any).fixture.info.released === 1)
    const result = await snapshot()
    assert.equal(result.state.reason, "invalid-message")
    assert.equal(result.transcript[0].text, "Hello")
    assert.deepEqual(result.info.prompts.map((item: any) => item.text), ["Queue this prompt"])
  } finally { await context.close() }
})

test("the client stops a silent active conversation even when its socket stays open", async () => {
  const { page, context, start, closed, snapshot } = await fixture()
  try {
    await page.clock.install()
    const send = await start()
    send({ type: "transcript", role: "assistant", text: "Assistant speech does not renew the timer.", final: true })
    await page.waitForFunction(() => (window as any).fixture.transcript().length === 1)
    await page.clock.fastForward(120_100)
    await closed
    assert.equal((await snapshot()).state.reason, "idle")
    assert.equal((await snapshot()).info.released, 1)
  } finally { await context.close() }
})

test("the composer opens consent, retains stopped turns, and keeps native input focus", async () => {
  const { page, context, socket, closed, opens, errors, waitForSent } = await fixture("gemini", true)
  const consent = page.locator(".live-voice-consent")
  const live = page.locator("#live-voice-conversation")
  const menu = () => page.getByRole("button", { name: "More actions", exact: true })
  const counts = () => page.evaluate(() => {
    const { capture, released } = (window as any).fixture.info
    return { capture, released }
  })
  try {
    const open = async () => {
      await menu().focus()
      await page.keyboard.press("Enter")
      await page.locator('[data-action-key="voice"]').waitFor()
      await page.keyboard.press("Home")
      await page.waitForFunction(() => document.activeElement?.getAttribute("data-action-key") === "voice")
      await page.keyboard.press("ArrowDown")
      await page.waitForFunction(() => document.activeElement?.getAttribute("data-action-key") === "conversation")
      await page.keyboard.press("Enter")
      await consent.waitFor()
      await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Cancel")
    }
    await open()
    assert.match(await consent.innerText(), /Google/i)
    assert.match(await consent.innerText(), /billed/i)
    await page.keyboard.press("Escape")
    await consent.waitFor({ state: "detached" })
    assert.equal(opens(), 0)
    assert.deepEqual(await counts(), { capture: 0, released: 0 })
    await open()
    await consent.getByRole("button", { name: "Agree and start" }).click()
    const ws = await socket
    await waitForSent(item => item.type === "start")
    const send = (message: object) => ws.send(JSON.stringify(message))
    send({ type: "ready", inputRate: 16_000, outputRate: 24_000 })
    await live.getByText("Listening", { exact: true }).waitFor()
    assert.equal(await live.locator(".live-voice-target bdi").textContent(), "Feature ABC — משימה 42")
    await live.getByRole("button", { name: "Mute microphone" }).click()
    assert.deepEqual(await waitForSent(item => item.type === "audio-end"), { type: "audio-end" })
    await live.getByText("Microphone muted", { exact: true }).waitFor()
    assert.equal((await counts()).capture, 1)
    assert.equal(await page.evaluate(() => (window as any).fixture.microphoneEnabled()), false)
    await live.getByRole("button", { name: "Mute microphone" }).click()
    await live.getByText("Listening", { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => (window as any).fixture.microphoneEnabled()), true)

    await menu().press("Enter")
    const dictation = page.getByRole("menuitemcheckbox", { name: "Dictation mode", exact: true })
    await dictation.waitFor()
    assert.equal(await dictation.isDisabled(), true)
    await page.keyboard.press("Escape")

    const second = await context.newPage()
    try {
      const unavailable = second.getByRole("menuitemcheckbox", { name: "Dictation mode — Live conversation is using the microphone." })
      await second.goto(page.url(), { waitUntil: "domcontentloaded" })
      await second.getByRole("button", { name: "More actions", exact: true }).click()
      await unavailable.click()
      await second.waitForFunction(() => document.activeElement?.id === "voice-dictation")
      await second.getByRole("button", { name: "Test API input", exact: true }).click()
      await second.getByRole("dialog").getByText("Live conversation is using the microphone.", { exact: true }).waitFor()
      assert.equal(await second.evaluate(() => (window as any).fixture.info.capture), 0)
    } finally { await second.close() }

    send({ type: "tool-call", id: "send", name: "send_to_agent", arguments: { text: "Ask the agent" } })
    await waitForSent(item => item.id === "send")
    await live.getByRole("list").getByText("Sent to session", { exact: true }).waitFor()
    await page.getByRole("button", { name: "Next request" }).press("Enter")
    const answer = page.locator(".interruption-dock").getByRole("textbox")
    await answer.focus()
    send({ type: "transcript", role: "assistant", text: "Continued answer", final: true })
    send({ type: "interrupted" })
    await live.getByRole("list").getByText("Response interrupted", { exact: true }).waitFor()
    assert.equal(await answer.evaluate(element => document.activeElement === element), true)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))

    await live.getByRole("button", { name: "Stop", exact: true }).click()
    await closed
    await page.waitForFunction(() => (window as any).fixture.info.released === 1)
    await live.getByText("Continued answer", { exact: true }).waitFor()
    await menu().press("Enter")
    await page.getByRole("menuitemcheckbox", { name: "Conversation mode", exact: true }).press("Enter")
    await page.waitForFunction(() => document.activeElement?.matches("#live-voice-conversation .window-close-button"))
    assert.equal(opens(), 1)
    await live.getByRole("button", { name: "Close", exact: true }).click()
    await live.waitFor({ state: "detached" })
    assert.equal(opens(), 1)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test("a long title wraps in consent and leaves the live Session label intact", async () => {
  const title = "Review the session " + "longUnbrokenTitle".repeat(18)
  const { context, consent, live, openConsent, acceptConsent, page } = await fixture("gemini", true, false, title)
  try {
    await openConsent()
    const name = consent.locator(".live-voice-target bdi")
    assert.equal(await name.textContent(), title)
    assert.ok(await name.evaluate(el => {
      const range = document.createRange()
      range.selectNodeContents(el)
      const lines = [...range.getClientRects()]
      const bounds = el.getBoundingClientRect()
      return lines.length > 1 && lines.every(line => line.left >= bounds.left - 1 && line.right <= bounds.right + 1)
    }))
    await acceptConsent()
    assert.equal(await live.locator(".live-voice-target bdi").textContent(), title)
    assert.ok(await live.locator(".live-voice-target").evaluate(el => {
      const label = el.querySelector("span")!
      const title = el.querySelector("bdi")!
      const range = document.createRange()
      range.selectNodeContents(label)
      const line = range.getBoundingClientRect()
      return label.textContent === "Session" && label.getBoundingClientRect().right >= line.right &&
        title.getBoundingClientRect().left > line.right && title.scrollWidth > title.clientWidth
    }))
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  } finally { await context.close() }
})

test("inactivity moves focus from the microphone to Close without stealing other focus", async () => {
  for (const focusMic of [true, false]) {
    const { page, context, live, openConsent, acceptConsent } = await fixture("gemini", true)
    try {
      await page.clock.install()
      await openConsent()
      await acceptConsent()
      const target = focusMic ? live.getByRole("button", { name: "Mute microphone" }) : page.getByRole("textbox").first()
      await target.focus()
      assert.ok(await target.evaluate(el => document.activeElement === el))
      await page.clock.fastForward(120_100)
      await live.getByText("Conversation ended due to inactivity", { exact: true }).waitFor()
      const expected = focusMic ? live.getByRole("button", { name: "Close", exact: true }) : target
      assert.ok(await expected.evaluate(el => document.activeElement === el))
    } finally { await context.close() }
  }
})

test("the duration limit transfers focus from the microphone to Close", async () => {
  const { page, context, live, openConsent, acceptConsent, waitForSent } = await fixture("gemini", true)
  try {
    await page.clock.install()
    await openConsent()
    const send = await acceptConsent()
    const mic = live.getByRole("button", { name: "Mute microphone" })
    await mic.focus()
    assert.ok(await mic.evaluate(el => document.activeElement === el))
    // Renew inactivity often enough to hit the absolute limit first.
    const step = LIVE_VOICE_IDLE_MS / 2
    for (let elapsed = step; elapsed < LIVE_VOICE_ABSOLUTE_MS; elapsed += step) {
      await page.clock.fastForward(step)
      send({ type: "activity" })
      send({ type: "tool-call", id: `activity-${elapsed}`, name: "get_session_status", arguments: {} })
      await waitForSent(item => item.id === `activity-${elapsed}`)
    }
    await page.clock.fastForward(step + 100)
    await live.getByText("Conversation time limit reached", { exact: true }).waitFor()
    assert.ok(await live.getByRole("button", { name: "Close", exact: true }).evaluate(el => document.activeElement === el))
  } finally { await context.close() }
})

test("OpenAI places late transcriptions in conversation item order without showing empty rows", async () => {
  const { context, start, snapshot, page } = await fixture("openai")
  try {
    const send = await start()
    const item = (itemId: string, previousItemId: string | null) => send({ type: "item-order", itemId, previousItemId })
    const line = (role: "user" | "assistant", itemId: string, text: string) =>
      send({ type: "transcript", role, itemId, text, final: true, replace: true })
    item("user-1", null)
    item("assistant-1", "user-1")
    line("assistant", "assistant-1", "First reply")
    send({ type: "turn-complete" })
    item("tool", "assistant-1")
    item("assistant-2", "tool")
    line("assistant", "assistant-2", "Second reply")
    send({ type: "turn-complete" })
    await page.waitForFunction(() => (window as any).fixture.transcript().length === 2)
    const texts = async () => (await snapshot()).transcript.map(({ role, text }: any) => [role, text])
    assert.deepEqual(await texts(), [["assistant", "First reply"], ["assistant", "Second reply"]])
    item("user-2", "tool")
    item("assistant-2", "tool") // Duplicate lifecycle event.
    line("user", "user-2", "Second question")
    line("user", "user-1", "First question")
    await page.waitForFunction(() => (window as any).fixture.transcript().length === 4)
    assert.deepEqual(await texts(), [
      ["user", "First question"], ["assistant", "First reply"], ["user", "Second question"], ["assistant", "Second reply"],
    ])
  } finally { await context.close() }
})

test("a dropped connection moves focus to Close only if the microphone held focus", async () => {
  for (const focusMic of [true, false]) {
    const { page, context, live, openConsent, acceptConsent, socket } = await fixture("gemini", true)
    try {
      await openConsent()
      await acceptConsent()
      const target = focusMic ? live.getByRole("button", { name: "Mute microphone" }) : page.getByRole("textbox").first()
      await target.focus()
      assert.ok(await target.evaluate(el => document.activeElement === el))
      await (await socket).close({ code: 1011 })
      await live.getByText("Couldn't connect to the provider", { exact: true }).waitFor()
      const expected = focusMic ? live.getByRole("button", { name: "Close", exact: true }) : target
      assert.ok(await expected.evaluate(el => document.activeElement === el))
    } finally { await context.close() }
  }
})

test("the live window displays the conversation limit if the gateway closes as busy before ready", async () => {
  const { context, live, consent, openConsent, socket } = await fixture("gemini", true)
  try {
    await openConsent()
    await consent.locator(".button-primary").click()
    await (await socket).close({ code: 4000, reason: "busy" })
    await live.getByRole("status").getByText("Voice is already in use", { exact: true }).waitFor()
  } finally { await context.close() }
})

test("Gemini stays in Thinking after a turn while the interaction is in progress", async () => {
  const { context, live, openConsent, acceptConsent, waitForSent } = await fixture("gemini", true)
  try {
    await openConsent()
    const send = await acceptConsent()
    send({ type: "thinking" })
    await live.getByText("Thinking", { exact: true }).waitFor()
    send({ type: "turn-complete", thinking: true })
    send({ type: "tool-call", name: "get_session_status", id: "progress-seen", arguments: {} })
    await waitForSent(item => item.id === "progress-seen")
    assert.equal(await live.getByText("Thinking", { exact: true }).isVisible(), true)
    assert.equal(await live.getByText("Listening", { exact: true }).isVisible(), false)
    send({ type: "turn-complete" })
    await live.getByText("Listening", { exact: true }).waitFor()
  } finally { await context.close() }
})

test("the live reply control identifies local-only Gemini playback and OpenAI interruption", async () => {
  for (const engine of ["gemini", "openai"] as const) {
    const { context, live, openConsent, acceptConsent, sent, waitForSent } = await fixture(engine, true)
    try {
      await openConsent()
      const send = await acceptConsent()
      send(engine === "gemini" ? { type: "thinking" } : { type: "thinking", responseId: "reply" })
      const assistant = live.locator('[data-role="assistant"] p')
      if (engine === "gemini") {
        send({ type: "transcript", role: "assistant", text: "Beginning of reply. ", final: false })
        await assistant.waitFor()
      }
      await live.getByRole("button", { name: engine === "gemini" ? "Stop playback" : "Interrupt reply", exact: true }).click()
      if (engine === "openai") {
        assert.deepEqual(await waitForSent(item => item.type === "interrupt"), { type: "interrupt", responseId: "reply" })
      } else {
        send({ type: "transcript", role: "assistant", text: "End of reply.", final: true })
        send({ type: "turn-complete" })
        send({ type: "tool-call", id: "send", name: "send_to_agent", arguments: { text: "Still a live request" } })
        assert.deepEqual(JSON.parse((await waitForSent(item => item.id === "send")).output), { delivery: "submitted" })
        assert.deepEqual(await assistant.allTextContents(), ["Beginning of reply. End of reply."])
        assert.equal(sent.some(item => item.type === "interrupt" || item.type === "truncate"), false)
      }
    } finally { await context.close() }
  }
})

test("OpenAI can interrupt a completed audio-free reply while its send awaits native admission", async () => {
  const { page, context, live, openConsent, acceptConsent, sent, waitForSent } = await fixture("openai", true)
  try {
    await openConsent()
    const send = await acceptConsent()
    await page.evaluate(() => (window as any).fixture.holdAdmission())
    send({ type: "thinking", responseId: "reply" })
    send({ type: "tool-call", responseId: "reply", id: "held", name: "send_to_agent", arguments: { text: "Do not send" } })
    send({ type: "turn-complete" })
    await page.waitForFunction(() => (window as any).fixture.waitingAdmission())
    send({ type: "tool-call", responseId: "reply", id: "receipt", name: "get_session_status", arguments: {} })
    await waitForSent(item => item.id === "receipt") // Confirms the browser has processed turn-complete.
    await live.getByText("Thinking", { exact: true }).waitFor()
    await live.getByRole("button", { name: "Interrupt reply", exact: true }).click({ timeout: 3000 })
    assert.deepEqual(await waitForSent(item => item.type === "interrupt"), { type: "interrupt", responseId: "reply" })
    await page.evaluate(() => (window as any).fixture.releaseAdmission())
    await page.waitForFunction(() => (window as any).fixture.info.admissionResumed)
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.info.prompts), [])
    assert.equal(sent.some(item => item.type === "tool-result" && item.id === "held"), false)
    await live.getByText("Listening", { exact: true }).waitFor()
  } finally { await context.close() }
})

test("playback overflow interrupts only the reply and truncates OpenAI at the rendered position", async () => {
  for (const engine of ["gemini", "openai"] as const) {
    const { page, context, live, openConsent, acceptConsent, sent, waitForSent } = await fixture(engine, true)
    try {
      await openConsent()
      const send = await acceptConsent()
      const openAI = engine === "openai"
      const audio = (itemId: string) => ({ type: "audio", pcm, ...(openAI ? { itemId, contentIndex: 0 } : {}) })
      send(openAI ? { type: "thinking", responseId: "overflow-reply" } : { type: "thinking" })
      send(audio("oversized"))
      await page.waitForFunction(() => (window as any).fixture.playback.rendered > 0)
      // Each frame is half a second of valid PCM; the burst outruns the 12 s ring.
      for (let index = 0; index < 32; index++) send(audio("oversized"))
      await live.getByRole("list").getByText("Response interrupted", { exact: true }).waitFor()
      await page.waitForFunction(() => (window as any).fixture.playback.flushed > 0)
      const flushed = await page.evaluate(() => (window as any).fixture.playback.flushed)
      if (openAI) {
        assert.deepEqual(await waitForSent(item => item.type === "interrupt"), { type: "interrupt", responseId: "overflow-reply" })
        assert.deepEqual(await waitForSent(item => item.type === "truncate"), {
          type: "truncate", itemId: "oversized", contentIndex: 0, audioEndMs: Math.floor(flushed * 1000 / 24_000),
        })
      } else assert.equal(sent.some(item => item.type === "interrupt" || item.type === "truncate"), false)

      send({ type: "turn-complete" })
      send(audio("next"))
      await page.waitForFunction(() => (window as any).fixture.playback.rendered > 0)
      send({ type: "tool-call", id: "still-open", ...(openAI ? { responseId: "next" } : {}), name: "get_session_status", arguments: {} })
      assert.equal(JSON.parse((await waitForSent(item => item.id === "still-open")).output).status, "idle")
      assert.equal(await live.getByRole("list").getByText("Response interrupted", { exact: true }).count(), 1)
    } finally { await context.close() }
  }
})

test("an overflowing OpenAI reply leaves the preceding reply queued and truncates only the overflow", async () => {
  const { page, context, live, openConsent, acceptConsent, sent, waitForSent } = await fixture("openai", true)
  try {
    await openConsent()
    const send = await acceptConsent()
    const audio = (itemId: string) => ({ type: "audio", pcm, itemId, contentIndex: 0 })
    send({ type: "thinking", responseId: "A" })
    for (let i = 0; i < 4; i++) send(audio("item-A"))
    send({ type: "turn-complete" })
    send({ type: "thinking", responseId: "B" })
    for (let i = 0; i < 32; i++) send(audio("item-B"))
    await live.getByText("Response interrupted", { exact: true }).first().waitFor()
    assert.deepEqual(await waitForSent(item => item.type === "interrupt"), { type: "interrupt", responseId: "B" })
    assert.deepEqual(await waitForSent(item => item.type === "truncate"), {
      type: "truncate", itemId: "item-B", contentIndex: 0, audioEndMs: 0,
    })
    const flushed = await page.evaluate(() => (window as any).fixture.playback.flushed)
    assert.ok(flushed < 48_000, "reply A still had samples at the cut")
    // Render A's entire two seconds without sending any more PCM.
    await page.waitForFunction(() => (window as any).fixture.playback.rendered === 48_000)
    assert.deepEqual(sent.filter(item => item.type === "truncate").map(item => item.itemId), ["item-B"])
  } finally { await context.close() }
})

test("barge-in after an OpenAI overflow stops the earlier reply still playing", async () => {
  const { page, context, live, openConsent, acceptConsent, waitForSent } = await fixture("openai", true)
  try {
    await openConsent()
    const send = await acceptConsent()
    const audio = (itemId: string) => ({ type: "audio", pcm, itemId, contentIndex: 0 })
    send({ type: "thinking", responseId: "A" })
    for (let i = 0; i < 8; i++) send(audio("item-A"))
    await page.waitForFunction(() => (window as any).fixture.playback.rendered > 0)
    send({ type: "turn-complete" })
    send({ type: "thinking", responseId: "B" })
    for (let i = 0; i < 32; i++) send(audio("item-B"))
    await waitForSent(item => item.type === "truncate" && item.itemId === "item-B")
    send({ type: "interrupted" }) // B's turn-complete has not arrived.
    const cut = await waitForSent(item => item.type === "truncate" && item.itemId === "item-A")
    assert.ok(cut.audioEndMs > 0 && cut.audioEndMs < 4000, "barge-in drops the remaining samples of A")
    await live.getByText("Listening", { exact: true }).waitFor()
    assert.equal(await live.getByRole("list").getByText("Response interrupted", { exact: true }).count(), 1)
  } finally { await context.close() }
})

test("Gemini speech start flushes a completed reply's queued audio without discarding the next reply", async () => {
  const { page, context, live, openConsent, acceptConsent } = await fixture("gemini", true)
  try {
    await openConsent()
    const send = await acceptConsent()
    send({ type: "thinking" })
    for (let i = 0; i < 8; i++) send({ type: "audio", pcm })
    await page.waitForFunction(() => (window as any).fixture.playback.rendered > 0)
    send({ type: "turn-complete" })
    send({ type: "speech-start" })
    await page.waitForFunction(() => (window as any).fixture.playback.flushed > 0)
    assert.ok(await page.evaluate(() => (window as any).fixture.playback.flushed < 96_000))
    await live.getByText("Listening", { exact: true }).waitFor()
    send({ type: "thinking" })
    send({ type: "transcript", role: "assistant", text: "Next reply", final: true })
    send({ type: "audio", pcm })
    await live.getByRole("list").getByText("Next reply", { exact: true }).waitFor()
    await page.waitForFunction(() => (window as any).fixture.playback.rendered > 0)
  } finally { await context.close() }
})

test("reopening a consented conversation by keyboard leaves focus on the live window", async () => {
  const { page, context, live, openConsent, acceptConsent, closed, nextSocket } = await fixture("gemini", true)
  try {
    await openConsent()
    await acceptConsent()
    const close = live.getByRole("button", { name: "Close", exact: true })
    await close.click()
    await closed
    await page.waitForFunction(() => (window as any).fixture.info.released === 1)
    const more = page.getByRole("button", { name: "More actions", exact: true })
    await more.press("Enter")
    const conversation = page.getByRole("menuitemcheckbox", { name: "Conversation mode", exact: true })
    await conversation.focus()
    await page.evaluate(() => {
      const focus: string[] = []
      Object.assign(window, { restartFocus: focus })
      document.addEventListener("focusin", event => {
        const element = event.target as HTMLElement
        if (element.closest("#live-voice-conversation")) focus.push("window")
        else if (element.matches(".prompt-actions-menu-trigger")) focus.push("trigger")
      })
    })
    const pending = nextSocket()
    await conversation.press("Enter")
    const socket = await pending
    socket.send(JSON.stringify({ type: "ready", inputRate: 16_000, outputRate: 24_000 }))
    await live.getByText("Listening", { exact: true }).waitFor()
    await page.getByRole("menu").waitFor({ state: "detached" })
    // Kobalte dispatches close autofocus on a later task, after the dialog has focused.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.deepEqual(await close.evaluate(button => ({
      closeFocused: document.activeElement === button,
      transitions: (window as any).restartFocus,
    })), { closeFocused: true, transitions: ["window"] })
  } finally { await context.close() }
})

test("the live log adds one receipt and one interruption, not partial speech", async () => {
  const { context, live, openConsent, acceptConsent, waitForSent } = await fixture("gemini", true)
  try {
    await openConsent()
    const send = await acceptConsent()
    const log = live.getByRole("log")
    await log.evaluate(el => {
      const additions: string[] = []
      Object.assign(el, { additions })
      new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
          if (node.textContent?.trim()) additions.push(node.textContent)
        }
      }).observe(el, { childList: true, subtree: true, characterData: true })
    })
    const call = { type: "tool-call", id: "send", name: "send_to_agent", arguments: { text: "Hello agent" } }
    send(call)
    send(call)
    await waitForSent(item => item.id === "send")
    send({ type: "transcript", role: "assistant", text: "First ", final: false })
    send({ type: "transcript", role: "assistant", text: "fragment", final: false })
    send({ type: "interrupted" })
    send({ type: "interrupted" })
    send({ type: "turn-complete" })
    send({ type: "tool-call", id: "done", name: "get_session_status", arguments: {} })
    await waitForSent(item => item.id === "done")
    assert.deepEqual(await log.evaluate(el => (el as HTMLElement & { additions: string[] }).additions),
      ["Sent to session", "Response interrupted"])
  } finally { await context.close() }
})

test("consent discloses direct sends in the dialog description before capture", async () => {
  const { context, consent, openConsent, opens, page } = await fixture("gemini", true)
  try {
    await openConsent()
    const description = await consent.getAttribute("aria-describedby")
    assert.match(await page.locator(`[id="${description}"]`).textContent() ?? "",
      /The voice assistant can send messages to the agent on your behalf without further confirmation\./)
    assert.equal(opens(), 0)
    assert.equal(await page.evaluate(() => (window as any).fixture.info.capture), 0)
  } finally { await context.close() }
})

test("consent replaces Start with a settings action when the provider key is removed", async () => {
  const { context, consent, openConsent, opens, page } = await fixture("gemini", true)
  try {
    await openConsent()
    const start = consent.getByRole("button", { name: "Agree and start" })
    await start.focus()
    await page.evaluate(() => (window as any).fixture.removeProviderKey())
    await consent.getByRole("status").getByText("Set up the provider in Voice settings").waitFor()
    assert.equal(await start.count(), 0)
    const settings = consent.getByRole("button", { name: "Voice settings", exact: true })
    assert.equal(await settings.evaluate(el => el === document.activeElement), true)
    await page.keyboard.press("Enter")
    await consent.waitFor({ state: "detached" })
    await page.waitForFunction(() => document.activeElement?.id === "voice-conversation")
    assert.equal(await page.evaluate(() => (window as any).fixture.info.capture), 0)
    assert.equal(opens(), 0)
  } finally { await context.close() }
})

test("the live window and its controls fit 320px with a Hebrew interface", async () => {
  const { page, context, socket, closed, errors, waitForSent } = await fixture("openai", true, true)
  const consent = page.locator(".live-voice-consent")
  const live = page.locator("#live-voice-conversation")
  try {
    await page.locator(".prompt-actions-menu-trigger").click()
    await page.locator('[data-action-key="conversation"]').click()
    await consent.waitFor()
    assert.match(await consent.innerText(), /OpenAI/)
    await consent.getByText("העוזר הקולי יכול לשלוח הודעות לסוכן בשמך ללא אישור נוסף.", { exact: true }).waitFor()
    assert.equal(await page.locator("html").getAttribute("dir"), "rtl")
    assert.ok(await consent.evaluate(el => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().width <= innerWidth))
    await consent.locator(".button-primary").click()
    const ws = await socket
    await waitForSent(item => item.type === "start")
    ws.send(JSON.stringify({ type: "ready", inputRate: 24_000, outputRate: 24_000 }))
    await live.locator(".live-voice-target bdi").waitFor()
    assert.ok(await live.evaluate(el => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().width <= innerWidth))
    const actions = live.locator(".live-voice-actions button")
    assert.equal(await actions.count(), 3)
    for (const button of await actions.all()) assert.ok(await button.evaluate(el => {
      const box = el.getBoundingClientRect()
      return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight
    }))
    ws.send(JSON.stringify({ type: "thinking", responseId: "response-test" }))
    await actions.nth(1).click()
    assert.deepEqual(await waitForSent(item => item.type === "interrupt"), { type: "interrupt", responseId: "response-test" })
    await live.locator('[data-role="interrupted"]').waitFor()
    await page.evaluate(() => (window as any).fixture.switchSession())
    await closed
    await live.waitFor({ state: "detached" })
    await page.waitForFunction(() => (window as any).fixture.info.released === 1)
    await page.evaluate(() => (window as any).fixture.openVoiceSettings())
    await page.waitForFunction(() => document.activeElement?.id === "voice-dictation")
    const settings = page.locator(".settings-section-stack")
    for (const card of await settings.locator(":scope > section").all()) {
      assert.ok(await card.evaluate(el => el.scrollWidth <= el.clientWidth))
    }
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})

test("Voice settings keep one shared credentials editor and switching engines does not start capture", async () => {
  const { page, context, opens, errors } = await fixture("gemini", true)
  try {
    await page.waitForFunction(() => Boolean((window as any).fixture?.openVoiceSettings))
    await page.evaluate(() => (window as any).fixture.openVoiceSettings())
    const dictation = page.getByRole("region", { name: "Dictation", exact: true })
    const playback = page.getByRole("region", { name: "Playback", exact: true })
    const conversation = page.getByRole("region", { name: "Conversation", exact: true })
    await dictation.getByRole("button", { name: "API credentials", exact: true }).click()
    await page.waitForFunction(() => document.activeElement?.id === "voice-playback")
    assert.deepEqual(await page.locator(".settings-section-stack > section h3").allTextContents(), ["Dictation", "Playback", "Conversation"])
    await playback.getByRole("button", { name: "Test playback", exact: true }).waitFor()
    await dictation.getByRole("button", { name: "Test API input", exact: true }).waitFor()
    assert.equal(await page.locator("details").filter({ has: page.getByText("API credentials", { exact: true }) }).count(), 1)
    const engine = conversation.getByRole("combobox", { name: "Conversation engine" })
    await engine.selectOption("openai-realtime")
    const key = conversation.getByPlaceholder("Key saved", { exact: true })
    assert.equal(await key.inputValue(), "")
    assert.equal(await conversation.getByRole("textbox", { name: "Model", exact: true }).inputValue(), "test-openai")
    await engine.selectOption("classic")
    assert.equal(await key.count(), 0)
    assert.equal(opens(), 0)
    assert.equal(await page.evaluate(() => (window as any).fixture.info.capture), 0)
    assert.deepEqual(errors, [])
  } finally { await context.close() }
})
