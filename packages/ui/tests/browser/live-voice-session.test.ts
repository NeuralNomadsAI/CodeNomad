import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
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
  })
  const destination = new URL(url)
  if (engine === "openai") destination.searchParams.set("openai", "")
  if (interactive) destination.searchParams.set("ui", "")
  if (hebrew) destination.searchParams.set("he", "")
  if (title) destination.searchParams.set("title", title)
  await page.goto(destination.href, { waitUntil: "domcontentloaded", timeout: 30_000 })
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
    await page.getByRole("menuitem", { name: "Dictate — Live conversation is using the microphone." }).waitFor()
    await page.keyboard.press("Escape")

    const second = await context.newPage()
    try {
      const unavailable = second.getByRole("menuitem", { name: "Dictate — Live conversation is using the microphone." })
      await second.goto(page.url(), { waitUntil: "domcontentloaded", timeout: 30_000 })
      await second.getByRole("button", { name: "More actions", exact: true }).click()
      await unavailable.click()
      await second.waitForFunction(() => document.activeElement?.id === "voice-dictation")
      await second.getByRole("button", { name: "Test input", exact: true }).click()
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
    await page.getByRole("menuitem", { name: "Conversation mode", exact: true }).press("Enter")
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
    await dictation.getByRole("button", { name: "Test input", exact: true }).waitFor()
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
