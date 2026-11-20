import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import {
  liveVoiceInputRate, type LiveVoiceClientMessage, type LiveVoiceEngine, type LiveVoiceServerMessage,
} from "../../../server/src/speech/live-voice-contract"
import { openLiveVoiceSession, type LiveVoiceActivity, type LiveVoiceTranscriptRow } from "./live-voice-session"

async function fixture(t: TestContext, engine: LiveVoiceEngine, execute?: Parameters<typeof openLiveVoiceSession>[0]["execute"]) {
  const sent: LiveVoiceClientMessage[] = []
  const played: string[] = []
  let transcript: readonly LiveVoiceTranscriptRow[] = []
  let activity: LiveVoiceActivity = "listening", interruptible = false, playing = false, muted = false
  let playbackChange!: (playing: boolean) => void
  const socket = Object.assign(new EventTarget(), {
    readyState: 1, bufferedAmount: 0,
    send: (value: string) => sent.push(JSON.parse(value)), close: () => {},
  })
  let wired!: () => void
  const socketCreated = new Promise<void>(resolve => { wired = resolve })
  const session = openLiveVoiceSession({
    engine,
    context: { project: "", branch: "", worktree: "", title: "", status: "idle" },
    current: () => true,
    socket: () => { wired(); return socket },
    startAudio: async options => {
      playbackChange = value => { playing = value; options.onPlaybackChange(value) }
      return {
        play: value => { played.push(value.pcm); playbackChange(true) },
        turnComplete: () => {},
        interrupt: async () => {
          const heard = playing
          playbackChange(false)
          return heard ? [{ type: "truncate", itemId: "item", contentIndex: 0, audioEndMs: 10 }] : []
        },
        setMuted: value => { muted = value },
        level: output => output ? 0.6 : muted ? 0 : 0.4,
        close: async () => {},
      }
    },
    execute: execute ?? (() => ({})),
    onReady: () => {},
    onStop: () => {},
    onTranscript: rows => { transcript = rows },
    onActivity: (value, canInterrupt) => { activity = value; interruptible = canInterrupt },
  })
  t.after(() => session.stop())
  const receive = (value: LiveVoiceServerMessage) => socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }))
  await socketCreated
  socket.dispatchEvent(new Event("open"))
  receive({ type: "ready", inputRate: liveVoiceInputRate(engine), outputRate: 24_000 })
  return {
    session, receive, sent, played, drain: () => playbackChange(false), rows: () => transcript,
    activity: () => activity, interruptible: () => interruptible,
  }
}

test("OpenAI interruption cancels the bound response and keeps only samples and text before the cut", async t => {
  const f = await fixture(t, "openai-realtime")
  f.receive({ type: "interrupted" }) // VAD speech start with no response is not an interruption.
  assert.deepEqual(f.rows(), [])
  f.receive({ type: "thinking", responseId: "response" })
  assert.equal(f.activity(), "thinking")
  assert.equal(f.interruptible(), true)
  f.receive({ type: "audio", pcm: "AAA=", itemId: "item", contentIndex: 0 })
  assert.equal(f.activity(), "speaking")
  assert.equal(f.session.activityLevel(), 0.6)
  f.receive({ type: "transcript", role: "assistant", text: "Before", final: false, itemId: "item" })
  f.session.interrupt()
  f.receive({ type: "interrupted" })
  f.receive({ type: "audio", pcm: "AQA=", itemId: "item", contentIndex: 0 })
  f.receive({ type: "transcript", role: "assistant", text: "Discard this", final: true, itemId: "item", replace: true })
  await Promise.resolve()
  assert.deepEqual(f.sent.slice(1), [
    { type: "interrupt", responseId: "response" },
    { type: "truncate", itemId: "item", contentIndex: 0, audioEndMs: 10 },
  ])
  assert.deepEqual(f.played, ["AAA="])
  assert.deepEqual(f.rows().map(row => [row.role, row.text, row.final, row.announce]), [
    ["assistant", "Before", true, undefined], ["interrupted", "", true, true],
  ])
  f.receive({ type: "turn-complete" })
  f.receive({ type: "audio", pcm: "AgA=", itemId: "next", contentIndex: 0 })
  f.drain()
  assert.equal(f.activity(), "speaking", "playback gaps should not announce a new activity state")
  f.receive({ type: "audio", pcm: "AwA=", itemId: "next", contentIndex: 0 })
  f.receive({ type: "transcript", role: "assistant", text: "Next response", final: true, itemId: "next" })
  f.receive({ type: "turn-complete" })
  assert.deepEqual(f.played, ["AAA=", "AgA=", "AwA="])
  assert.equal(f.activity(), "speaking")
  assert.equal(f.rows().at(-1)?.announce, undefined)
  f.drain()
  assert.equal(f.activity(), "listening")
  assert.equal(f.rows().at(-1)?.announce, true)
})

test("muting flushes Gemini audio once per transition without sending an OpenAI control", async t => {
  for (const engine of ["gemini-live", "openai-realtime"] as const) {
    const f = await fixture(t, engine)
    for (const muted of [true, true, false, true]) assert.equal(f.session.setMuted(muted), true)
    assert.deepEqual(f.sent.slice(1), engine === "gemini-live" ? [{ type: "audio-end" }, { type: "audio-end" }] : [])
  }
})

test("OpenAI refuses an interrupted reply's late tools after turn-complete and admits another reply", async t => {
  const executed: string[] = []
  const f = await fixture(t, "openai-realtime", tool => {
    if (tool.name === "send_to_agent") executed.push(tool.arguments.text)
    return {}
  })
  f.receive({ type: "thinking", responseId: "interrupted" })
  f.session.interrupt()
  f.receive({ type: "turn-complete" })
  f.receive({ type: "thinking", responseId: "next" })
  const call = (id: string, responseId: string) => f.receive({
    type: "tool-call", id, responseId, name: "send_to_agent", arguments: { text: id },
  })
  call("too-late", "interrupted")
  call("new-reply", "next")
  await Promise.resolve()
  assert.deepEqual(executed, ["new-reply"])
  assert.deepEqual(f.sent.filter(value => value.type === "tool-result").map(value => value.id), ["new-reply"])
})

test("Gemini closes user rows on transcription completion, independent of model turns", async t => {
  const f = await fixture(t, "gemini-live")
  f.receive({ type: "transcript", role: "user", text: "First ", final: false, itemId: "a" })
  f.receive({ type: "turn-complete" })
  assert.deepEqual(f.rows().map(row => [row.text, row.final, row.announce]), [["First ", false, undefined]])
  f.receive({ type: "transcript", role: "user", text: "", final: true, itemId: "a" })
  f.receive({ type: "transcript", role: "user", text: "Second utterance", final: true, itemId: "b" })
  f.receive({ type: "transcript", role: "user", text: "utterance", final: true, itemId: "a" })
  assert.deepEqual(f.rows().map(row => [row.text, row.final, row.announce]), [
    ["First utterance", true, true], ["Second utterance", true, true],
  ])
})

test("Gemini manual interrupt drops local output only, and receipts require a confirmed native send", async t => {
  let confirm!: (value: { delivery: "queued" }) => void
  const execution = new Promise<{ delivery: "queued" }>(resolve => { confirm = resolve })
  const f = await fixture(t, "gemini-live", () => execution)
  f.receive({ type: "thinking" })
  f.receive({ type: "transcript", role: "assistant", text: "Before ", final: false })
  f.session.interrupt()
  f.receive({ type: "audio", pcm: "AAA=" })
  f.receive({ type: "transcript", role: "assistant", text: "and after.", final: true })
  f.receive({ type: "turn-complete" })
  f.receive({ type: "audio", pcm: "AQA=" })
  await Promise.resolve()
  assert.deepEqual(f.played, ["AQA="])
  assert.deepEqual(f.sent.map(value => value.type), ["start"])
  const call = { type: "tool-call", name: "send_to_agent", arguments: { text: " Draft this " }, id: "call" } as const
  f.receive(call)
  f.receive(call)
  f.receive({ type: "tool-cancel", id: call.id })
  assert.deepEqual(f.rows().map(row => [row.role, row.text, row.final]), [
    ["assistant", "Before and after.", true], ["interrupted", "", true],
  ])
  confirm({ delivery: "queued" })
  await Promise.resolve()
  assert.deepEqual(f.rows().map(row => row.role), ["assistant", "interrupted", "sent"])
  assert.equal(f.rows().at(-1)?.text, "Draft this")
  assert.deepEqual(f.sent.map(value => value.type), ["start"])
})
