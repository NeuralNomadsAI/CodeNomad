import assert from "node:assert/strict"
import { once } from "node:events"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import test, { type TestContext } from "node:test"
import pino from "pino"
import { Agent, fetch } from "undici"
import WebSocket, { WebSocketServer } from "ws"
import { DEVICE_COOKIE_NAME } from "../remote-control/gate"
import { RemoteDeviceRegistry } from "../remote-control/devices"
import { FAKE_TUNNEL_HOST, startRemoteSurface } from "../remote-control/test-support/surface"
import { RemoteProxySessionManager } from "../server/remote-proxy"
import { resolveHttpsOptions } from "../server/tls"
import {
  LIVE_VOICE_CLIENT_BYTES, LIVE_VOICE_PROVIDER_BYTES, LIVE_VOICE_TOOL_NAMES, liveVoiceTarget, type LiveVoiceEngine,
} from "./live-voice-contract"
import { LiveVoiceGateway } from "./live-voice-gateway"
import type { VoiceConversationProviderSettings } from "./voice-conversation-config"

const KEY = "voice-secret-sentinel-not-a-real-key"
const PCM = Buffer.from([14, 21, 1, 0]).toString("base64")
const gemini = liveVoiceTarget("gemini-live")
const openai = liveVoiceTarget("openai-realtime")
const context = { project: "Voice fixture", branch: "dev", worktree: "root", title: "Voice", status: "idle" }

function logger() {
  const logs: string[] = []
  return { logs, log: pino({ level: "trace" }, { write: line => { logs.push(line) } }) }
}

function wire(ws: WebSocket) {
  const messages: string[] = []
  const closed = new Promise<[number, string]>(resolve => ws.once("close", (code, reason) => resolve([code, reason.toString()])))
  ws.on("error", () => {})
  ws.on("message", data => messages.push(data.toString()))
  return {
    ws, messages, closed,
    next: async () => {
      if (!messages.length) await once(ws, "message")
      return JSON.parse(messages.shift()!)
    },
    send: (value: object, binary = false) => ws.send(JSON.stringify(value), { binary }),
  }
}

async function provider(t: TestContext, options: ConstructorParameters<typeof LiveVoiceGateway>[1] = {}) {
  const connections: Array<{ url: URL; headers?: Record<string, string> }> = []
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  const peers: ReturnType<typeof wire>[] = []
  wss.on("connection", ws => peers.push(wire(ws)))
  await once(wss, "listening")
  const { port } = wss.address() as net.AddressInfo
  t.after(() => {
    for (const ws of wss.clients) ws.terminate()
    return new Promise<void>(resolve => wss.close(() => resolve()))
  })
  const settings = (engine: string): VoiceConversationProviderSettings | undefined => {
    if (engine === "gemini-live") return { provider: "geminiLive", apiKey: KEY, model: "server-gemini", voice: "Kore" }
    if (engine === "openai-realtime") return { provider: "openaiRealtime", apiKey: KEY, model: "server-openai", voice: "marin" }
  }
  const gateway = new LiveVoiceGateway({ getVoiceConversationProvider: settings }, {
    ...options,
    connect: (url, opts) => {
      connections.push({ url, headers: opts.headers })
      assert.equal(opts.followRedirects, false)
      assert.equal(opts.rejectUnauthorized, true)
      return new WebSocket(`ws://127.0.0.1:${port}${url.pathname}${url.search}`, opts)
    },
  })
  const next = async () => {
    if (!peers.length) await once(wss, "connection")
    return peers.shift()!
  }
  return { gateway, next, connections }
}

function connect(t: TestContext, host: string, target: string, headers: Record<string, string>, secure = false) {
  const ws = new WebSocket(`${secure ? "wss" : "ws"}://${host}${target}`, { headers, rejectUnauthorized: false })
  t.after(() => ws.terminate())
  const client = wire(ws)
  ws.once("open", () => client.send({ type: "start", context }))
  return client
}

async function denied(host: string, target: string, headers: Record<string, string>, status: number, secure = false) {
  const ws = new WebSocket(`${secure ? "wss" : "ws"}://${host}${target}`, { headers, rejectUnauthorized: false })
  ws.on("error", () => {})
  const received = await new Promise<number>((resolve, reject) => {
    ws.once("unexpected-response", (_request, response) => { response.resume(); ws.terminate(); resolve(response.statusCode!) })
    ws.once("open", () => { ws.terminate(); reject(new Error("Unexpected voice upgrade")) })
    ws.once("error", reject)
  })
  assert.equal(received, status)
}

async function setupGemini(client: ReturnType<typeof wire>, fake: Awaited<ReturnType<typeof provider>>) {
  const upstream = await fake.next()
  const { setup } = await upstream.next()
  assert.equal(setup.model, "models/server-gemini")
  assert.equal(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Kore")
  assert.deepEqual(setup.tools[0].functionDeclarations.map((tool: { name: string }) => tool.name), LIVE_VOICE_TOOL_NAMES)
  assert.ok(setup.systemInstruction.parts[0].text.endsWith(JSON.stringify(context)))
  upstream.send({ setupComplete: {} }, true)
  assert.deepEqual(await client.next(), { type: "ready", inputRate: 16000, outputRate: 24000 })
  return upstream
}

test("a refused voice upgrade destroys the server socket even while the peer keeps writing open", { timeout: 5000 }, async t => {
  let serverClosed!: () => void
  const closed = new Promise<void>(resolve => { serverClosed = resolve })
  const { local } = await startRemoteSurface(t, {
    configureApp: app => {
      app.server.on("upgrade", (_request, socket) => socket.once("close", serverClosed))
    },
  })
  const socket = net.connect({ port: Number(local.split(":").at(-1)), host: "127.0.0.1", allowHalfOpen: true })
  t.after(() => { socket.destroy() })
  await once(socket, "connect")
  let response = ""
  socket.on("data", data => { response += data.toString() })
  socket.write(`GET ${gemini} HTTP/1.1\r\nHost: ${local}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`)
  await once(socket, "end")
  assert.match(response, /^HTTP\/1\.1 403 Forbidden\r\n/)
  assert.equal(socket.writableEnded, false)
  await closed
})

test("malformed cookie headers refuse direct and tunnel admission without affecting the next upgrade", { timeout: 10000 }, async t => {
  const fake = await provider(t)
  const { local, manager, target, code, authManager } = await startRemoteSurface(t, { liveVoice: fake.gateway })
  const origin = `http://${local}`
  const cookie = `${authManager.getCookieName()}=${authManager.createSession("codenomad").id}`
  const paired = manager.exchangePairing(code, undefined)!
  const remote = { host: FAKE_TUNNEL_HOST, origin: `https://${FAKE_TUNNEL_HOST}`, cookie: `${DEVICE_COOKIE_NAME}=${paired.token}` }
  await denied(local, gemini, { origin, cookie: `${cookie}; malformed=%` }, 401)
  await denied(target(), gemini, { ...remote, cookie: `${remote.cookie}; malformed=%` }, 403)
  assert.equal(fake.connections.length, 0)
  await setupGemini(connect(t, local, gemini, { origin, cookie }), fake)
  await setupGemini(connect(t, target(), gemini, remote), fake)
})

test("an unwritable paired-device registry closes only the affected voice upgrade", { timeout: 10000 }, async t => {
  const fake = await provider(t)
  const { manager, target, code, registryPath } = await startRemoteSurface(t, { liveVoice: fake.gateway })
  const paired = manager.exchangePairing(code, undefined)!
  const headers = { host: FAKE_TUNNEL_HOST, origin: `https://${FAKE_TUNNEL_HOST}`, cookie: `${DEVICE_COOKIE_NAME}=${paired.token}` }
  const tempPath = `${registryPath}.${process.pid}.tmp`
  fs.mkdirSync(tempPath) // A directory at the atomic-write path fails on every platform.
  assert.deepEqual(await connect(t, target(), gemini, headers).closed, [1006, ""])
  assert.equal(fake.connections.length, 0)
  fs.rmdirSync(tempPath)
  await setupGemini(connect(t, target(), gemini, headers), fake)
})

test("a failed revocation write reports failure and disconnects the live device and provider", { timeout: 10000 }, async t => {
  const fake = await provider(t)
  const { local, manager, target, code, registryPath } = await startRemoteSurface(t, { liveVoice: fake.gateway, skipAuth: true })
  const { device, token } = manager.exchangePairing(code, undefined)!
  const headers = { host: FAKE_TUNNEL_HOST, origin: `https://${FAKE_TUNNEL_HOST}`, cookie: `${DEVICE_COOKIE_NAME}=${token}` }
  const client = connect(t, target(), gemini, headers)
  const upstream = await setupGemini(client, fake)
  fs.mkdirSync(`${registryPath}.${process.pid}.tmp`)
  const response = await fetch(`http://${local}/api/remote-control/devices/${device.id}`, { method: "DELETE" })
  await response.text()
  assert.equal(response.status, 500)
  assert.equal(manager.isDeviceAuthorized(device.id), false)
  assert.deepEqual(await client.closed, [1006, ""])
  await upstream.closed
  await denied(target(), gemini, headers, 403)
})

test("a pending revocation refuses upgrades and can be retried durably", { timeout: 10000 }, async t => {
  const { local, manager, target, code, registryPath } = await startRemoteSurface(t, { skipAuth: true })
  const { device, token } = manager.exchangePairing(code, undefined)!
  const tempPath = `${registryPath}.${process.pid}.tmp`
  fs.mkdirSync(tempPath)
  const revoke = () => fetch(`http://${local}/api/remote-control/devices/${device.id}`, { method: "DELETE" })
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await revoke()
    await response.text()
    assert.equal(response.status, 500)
    assert.equal(manager.isDeviceAuthorized(device.id), false)
  }
  await denied(target(), gemini, { host: FAKE_TUNNEL_HOST, origin: `https://${FAKE_TUNNEL_HOST}`,
    cookie: `${DEVICE_COOKIE_NAME}=${token}` }, 403)
  const devices = () => fetch(`http://${local}/api/remote-control/devices`).then(response => response.json())
  assert.deepEqual(await devices(), { devices: [{ ...device, revocationPending: true }] })
  assert.equal(manager.status().pairedDevices, 0)
  assert.equal(new RemoteDeviceRegistry(registryPath).isPaired(device.id), true)
  fs.rmdirSync(tempPath)
  assert.equal((await revoke()).status, 204)
  assert.deepEqual(await devices(), { devices: [] })
  assert.equal(new RemoteDeviceRegistry(registryPath).authenticate(token), null)
  const absent = await revoke()
  await absent.text()
  assert.equal(absent.status, 404)
})

test("Gemini distinguishes an audio turn boundary from an idle interaction", { timeout: 10000 }, async t => {
  const fake = await provider(t)
  const { local } = await startRemoteSurface(t, { liveVoice: fake.gateway, skipAuth: true })
  const client = connect(t, local, gemini, { origin: `http://${local}` })
  const upstream = await setupGemini(client, fake)
  upstream.send({ serverContent: { turnComplete: true, interactionStatus: "IN_PROGRESS" } })
  assert.deepEqual(await client.next(), { type: "turn-complete", thinking: true })
  upstream.send({ serverContent: { turnComplete: true, interactionStatus: "IDLE" } })
  assert.deepEqual(await client.next(), { type: "turn-complete" })
})

test("Gemini binds late fragments by offset when available and keeps the new utterance open across turnComplete", { timeout: 10000 }, async t => {
  const fake = await provider(t)
  const { local } = await startRemoteSurface(t, { liveVoice: fake.gateway, skipAuth: true })
  const client = connect(t, local, gemini, { origin: `http://${local}` })
  const upstream = await setupGemini(client, fake)
  const speechStart = async (audioOffset?: string) => {
    upstream.send({ voiceActivity: { type: "ACTIVITY_START", audioOffset } })
    assert.deepEqual(await client.next(), { type: "activity" })
  }
  const fragment = async (text: string, itemId: string, startOffset?: string, final = false) => {
    upstream.send({ serverContent: { inputTranscription: { text, startOffset } } })
    assert.deepEqual(await client.next(), { type: "activity" })
    assert.deepEqual(await client.next(), { type: "transcript", role: "user", text, itemId, final })
  }
  const turnComplete = async () => {
    upstream.send({ serverContent: { turnComplete: true } })
    assert.deepEqual(await client.next(), { type: "turn-complete" })
  }
  await turnComplete()
  await fragment("Late A", "user-0")
  await speechStart()
  assert.deepEqual(await client.next(), { type: "transcript", role: "user", text: "", itemId: "user-0", final: true })
  assert.deepEqual(await client.next(), { type: "speech-start" })
  await fragment("New B", "user-1")
  await turnComplete()
  await fragment(" part 2", "user-1")

  await speechStart("1.25s")
  assert.deepEqual(await client.next(), { type: "transcript", role: "user", text: "", itemId: "user-1", final: true })
  assert.deepEqual(await client.next(), { type: "speech-start" })
  await fragment("A", "user-2", "1.40s")
  await speechStart("2.5s")
  assert.deepEqual(await client.next(), { type: "transcript", role: "user", text: "", itemId: "user-2", final: true })
  assert.deepEqual(await client.next(), { type: "speech-start" })
  await fragment("B", "user-3", "2.5s")
  await turnComplete()
  await fragment(" tail of A", "user-2", "2.499999999s", true)
  await fragment(" tail of B", "user-3", "2.75s")
})

test("direct admission, Gemini binary messages, fixed tools, cancellation and password logout", { timeout: 10000 }, async t => {
  const fake = await provider(t)
  const { log, logs } = logger()
  const { local, authManager } = await startRemoteSurface(t, {
    liveVoice: fake.gateway, logger: log, allowedOrigins: ["https://preview-id.preview.localhost"],
  })
  const origin = `http://${local}`
  const cookie = `${authManager.getCookieName()}=${authManager.createSession("codenomad").id}`
  await denied(local, gemini, { origin }, 401)
  for (const invalid of ["null", "https://other.test", "https://preview-id.preview.localhost", `${origin}/`]) {
    await denied(local, gemini, { origin: invalid, cookie }, 403)
  }
  await denied(local, gemini, { cookie }, 403)
  await denied(local, gemini, { origin, cookie, host: "04b00c64-b56e-4a73-bc88-8058f0f70b85.preview.localhost" }, 403)
  await denied(local, `${gemini}&model=arbitrary`, { origin, cookie }, 404)
  assert.equal(fake.connections.length, 0)

  const client = connect(t, local, gemini, { origin, cookie })
  const upstream = await setupGemini(client, fake)
  assert.equal(fake.connections[0].url.hostname, "generativelanguage.googleapis.com")
  assert.equal(fake.connections[0].url.search, "")
  assert.deepEqual(fake.connections[0].headers, { "x-goog-api-key": KEY })
  const secondLogin = `${authManager.getCookieName()}=${authManager.createSession("codenomad").id}`
  assert.deepEqual(await connect(t, local, openai, { origin, cookie: secondLogin }).closed, [4000, "busy"])
  assert.equal(fake.connections.length, 1, "a second login for the same user never reaches a provider")
  client.send({ type: "audio", pcm: PCM })
  assert.deepEqual(await upstream.next(), { realtimeInput: { audio: { data: PCM, mimeType: "audio/pcm;rate=16000" } } })
  client.send({ type: "audio-end" })
  assert.deepEqual(await upstream.next(), { realtimeInput: { audioStreamEnd: true } })
  client.send({ type: "audio", pcm: PCM })
  assert.deepEqual(await upstream.next(), { realtimeInput: { audio: { data: PCM, mimeType: "audio/pcm;rate=16000" } } })
  upstream.send({ serverContent: { modelTurn: { parts: [{ inlineData: { data: PCM, mimeType: "audio/pcm;rate=24000" } }] } } }, true)
  assert.deepEqual(await client.next(), { type: "audio", pcm: PCM })
  upstream.send({ toolCall: { functionCalls: [{ id: "call1", name: "send_to_agent", args: { text: "Draft a plan" } }] } }, true)
  upstream.send({ toolCall: { functionCalls: [{ id: "call1", name: "send_to_agent", args: { text: "Duplicate" } }] } }, true)
  assert.deepEqual(await client.next(), { type: "tool-call", id: "call1", name: "send_to_agent", arguments: { text: "Draft a plan" } })
  client.send({ type: "tool-result", id: "call1", output: "Submitted" })
  assert.deepEqual(await upstream.next(), { toolResponse: { functionResponses: [{ name: "send_to_agent", id: "call1", response: { output: "Submitted" } }] } })

  upstream.send({ toolCall: { functionCalls: [{ id: "call2", name: "get_session_status" }] } })
  assert.deepEqual(await client.next(), { type: "tool-call", id: "call2", name: "get_session_status", arguments: {} })
  upstream.send({ toolCallCancellation: { ids: ["call2"] } }, true)
  upstream.send({ serverContent: { interrupted: true, turnComplete: true } })
  assert.deepEqual(await client.next(), { type: "tool-cancel", id: "call2" })
  assert.deepEqual(await client.next(), { type: "interrupted" })
  assert.deepEqual(await client.next(), { type: "turn-complete" })
  client.send({ type: "tool-result", id: "call2", output: "Too late" })
  client.send({ type: "audio", pcm: PCM })
  assert.deepEqual(await upstream.next(), { realtimeInput: { audio: { data: PCM, mimeType: "audio/pcm;rate=16000" } } })
  const quit = await fetch(`${origin}/api/auth/logout`, { method: "POST", headers: { origin, cookie } })
  await quit.text()
  assert.equal(quit.status, 200)
  assert.deepEqual(await client.closed, [4000, "revoked"])
  await upstream.closed
  assert(!logs.join("").includes(KEY))
})

test("Remote Control needs its device credential even without local auth; OpenAI GA goes through the narrower gateway", { timeout: 10000 }, async t => {
  const fake = await provider(t)
  const { manager, target, code } = await startRemoteSurface(t, { skipAuth: true, liveVoice: fake.gateway })
  const origin = `https://${FAKE_TUNNEL_HOST}`
  const paired = manager.exchangePairing(code, undefined)!
  const cookie = `${DEVICE_COOKIE_NAME}=${paired.token}`
  const headers = { host: FAKE_TUNNEL_HOST, origin, cookie }
  await denied(target(), openai, { ...headers, cookie: "codenomad_session=auth-disabled" }, 403)
  await denied(target(), openai, { ...headers, origin: "null" }, 403)
  await denied(target(), openai, { ...headers, host: "localhost" }, 403)
  await denied(target(), `${openai}&key=untrusted`, headers, 404)
  assert.equal(fake.connections.length, 0)

  const client = connect(t, target(), openai, headers)
  const upstream = await fake.next()
  assert.equal(fake.connections[0].url.href, "wss://api.openai.com/v1/realtime?model=server-openai")
  assert.deepEqual(fake.connections[0].headers, { Authorization: `Bearer ${KEY}` })
  upstream.send({ type: "session.created", session: { id: "session-1", arbitrary: KEY } })
  const update = await upstream.next()
  assert.equal(update.type, "session.update")
  assert.equal(update.session.audio.input.format.rate, 24000)
  assert.equal(update.session.audio.output.voice, "marin")
  assert.equal(update.session.audio.input.turn_detection.interrupt_response, true)
  assert.deepEqual(update.session.tools.map((tool: { name: string }) => tool.name), LIVE_VOICE_TOOL_NAMES)
  assert.ok(update.session.instructions.endsWith(JSON.stringify(context)))
  upstream.send({ type: "session.updated", session: { id: "session-1", arbitrary: KEY } })
  assert.deepEqual(await client.next(), { type: "ready", inputRate: 24000, outputRate: 24000 })
  client.send({ type: "audio", pcm: PCM })
  assert.deepEqual(await upstream.next(), { type: "input_audio_buffer.append", audio: PCM })
  upstream.send({ type: "response.output_audio.delta", response_id: "response-1", item_id: "item-1", content_index: 0, delta: PCM })
  assert.deepEqual(await client.next(), { type: "audio", pcm: PCM, itemId: "item-1", contentIndex: 0 })
  upstream.send({ type: "input_audio_buffer.speech_started" })
  assert.deepEqual(await client.next(), { type: "activity" })
  assert.deepEqual(await client.next(), { type: "interrupted" })
  client.send({ type: "truncate", itemId: "item-1", contentIndex: 0, audioEndMs: 0 })
  assert.deepEqual(await upstream.next(), { type: "conversation.item.truncate", item_id: "item-1", content_index: 0, audio_end_ms: 0 })
  upstream.send({ type: "response.done", response: {
    id: "response-2", status: "completed", output: [{ type: "function_call", status: "completed", call_id: "call-1", name: "get_last_reply", arguments: "{}" }],
  } })
  assert.deepEqual(await client.next(), { type: "tool-call", name: "get_last_reply", id: "call-1", arguments: {}, responseId: "response-2" })
  assert.deepEqual(await client.next(), { type: "turn-complete" })
  client.send({ type: "tool-result", id: "call-1", output: "Working" })
  assert.deepEqual(await upstream.next(), { type: "conversation.item.create", item: { type: "function_call_output", call_id: "call-1", output: "Working" } })
  assert.deepEqual(await upstream.next(), { type: "response.create" })
  upstream.send({ type: "response.created", response: { id: "response-3" } })
  assert.deepEqual(await client.next(), { type: "thinking", responseId: "response-3" })
  client.send({ type: "interrupt", responseId: "response-2" })
  client.send({ type: "interrupt", responseId: "response-3" })
  client.send({ type: "interrupt", responseId: "response-3" })
  const cancel = await upstream.next()
  assert.deepEqual(cancel, { type: "response.cancel", response_id: "response-3", event_id: "codenomad-cancel-1" })
  upstream.send({ type: "response.done", response: { id: "response-3", status: "completed", output: [] } })
  // A correlated cancel error after natural completion cannot tear down the conversation.
  upstream.send({ type: "error", error: { event_id: cancel.event_id, code: "response_cancel_not_active" } })
  assert.deepEqual(await client.next(), { type: "turn-complete" })
  client.send({ type: "audio", pcm: PCM })
  assert.deepEqual(await upstream.next(), { type: "input_audio_buffer.append", audio: PCM })
  manager.setPreviewsAllowed(false)
  assert.equal(client.ws.readyState, WebSocket.OPEN)
  manager.revokeDevice(paired.device.id)
  assert.equal((await client.closed)[0], 1006)
  await upstream.closed
})

test("OpenAI relays item ordering separately from late transcription text", { timeout: 10000 }, async t => {
  const fake = await provider(t)
  const { local } = await startRemoteSurface(t, { liveVoice: fake.gateway, skipAuth: true })
  const client = connect(t, local, openai, { origin: `http://${local}` })
  const upstream = await fake.next()
  upstream.send({ type: "session.created", session: {} })
  assert.equal((await upstream.next()).type, "session.update")
  upstream.send({ type: "session.updated", session: {} })
  assert.equal((await client.next()).type, "ready")
  upstream.send({ type: "input_audio_buffer.committed", item_id: "user", previous_item_id: null })
  upstream.send({ type: "conversation.item.created", item: { id: "tool", arguments: "private" }, previous_item_id: "user" })
  upstream.send({ type: "conversation.item.added", item: { id: "assistant" }, previous_item_id: "tool" })
  upstream.send({ type: "response.output_audio_transcript.done", response_id: "reply", item_id: "assistant", transcript: "Pong" })
  upstream.send({ type: "response.done", response: { id: "reply", status: "completed", output: [] } })
  upstream.send({ type: "conversation.item.input_audio_transcription.completed", item_id: "user", transcript: "Ping" })
  assert.deepEqual(await client.next(), { type: "item-order", itemId: "user", previousItemId: null })
  assert.deepEqual(await client.next(), { type: "item-order", itemId: "tool", previousItemId: "user" })
  assert.deepEqual(await client.next(), { type: "item-order", itemId: "assistant", previousItemId: "tool" })
  assert.deepEqual(await client.next(), { type: "transcript", role: "assistant", itemId: "assistant", text: "Pong", final: true, replace: true })
  assert.deepEqual(await client.next(), { type: "turn-complete" })
  assert.deepEqual(await client.next(), { type: "transcript", role: "user", itemId: "user", text: "Ping", final: true, replace: true })
})

test("OpenAI interruption settles raced function calls for completed replies without forwarding late sends", { timeout: 10000 }, async t => {
  const fake = await provider(t)
  const { local } = await startRemoteSurface(t, { liveVoice: fake.gateway, skipAuth: true })
  const client = connect(t, local, openai, { origin: `http://${local}` })
  const upstream = await fake.next()
  upstream.send({ type: "session.created", session: {} })
  assert.equal((await upstream.next()).type, "session.update")
  upstream.send({ type: "session.updated", session: {} })
  assert.equal((await client.next()).type, "ready")
  upstream.send({ type: "response.created", response: { id: "reply" } })
  assert.equal((await client.next()).type, "thinking")
  const done = (id: string) => upstream.send({ type: "response.done", response: { id: "reply", status: "completed", output: [
    { type: "function_call", status: "completed", call_id: id, name: "send_to_agent", arguments: '{"text":"Do not send"}' },
  ] } })
  const cancelled = (id: string) => ({ type: "conversation.item.create", item: { type: "function_call_output", call_id: id, output: "Interrupted by the user." } })
  done("in-flight")
  assert.deepEqual(await client.next(), { type: "tool-call", id: "in-flight", responseId: "reply", name: "send_to_agent", arguments: { text: "Do not send" } })
  assert.equal((await client.next()).type, "turn-complete")
  client.send({ type: "interrupt", responseId: "reply" })
  assert.deepEqual(await upstream.next(), cancelled("in-flight"))
  assert.deepEqual(await client.next(), { type: "tool-cancel", id: "in-flight" })
  done("late")
  assert.deepEqual(await upstream.next(), cancelled("late"))
  assert.deepEqual(await client.next(), { type: "tool-cancel", id: "late" })
  assert.equal((await client.next()).type, "turn-complete")
  client.send({ type: "tool-result", id: "in-flight", output: "Late browser result" })
  client.send({ type: "audio", pcm: PCM })
  assert.deepEqual(await upstream.next(), { type: "input_audio_buffer.append", audio: PCM })
})

test("Tauri TLS-exception window requires bootstrap and upstream login, and revokes both streams on disposal", { timeout: 15000 }, async t => {
  const { log, logs } = logger()
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-voice-window-"))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const tls = resolveHttpsOptions({ enabled: true, host: "127.0.0.1", configDir: base, logger: log })!.httpsOptions
  const fake = await provider(t)
  // Separate installations in production have separate listener registries. A test TCP hop
  // presents the fixture as a distinct advertised address without weakening the proxy guard.
  let backendPort = 0
  const forward = net.createServer(socket => {
    const upstream = net.connect(backendPort, "127.0.0.1")
    socket.on("error", () => upstream.destroy())
    upstream.on("error", () => socket.destroy())
    socket.on("close", () => upstream.destroy())
    upstream.on("close", () => socket.destroy())
    socket.pipe(upstream).pipe(socket)
  })
  forward.listen(0, "127.0.0.1")
  await once(forward, "listening")
  t.after(() => { forward.close() })
  const target = `https://127.0.0.1:${(forward.address() as net.AddressInfo).port}`
  const { local, authManager } = await startRemoteSurface(t, { liveVoice: fake.gateway, httpsOptions: tls, allowedOrigins: [target], logger: log })
  backendPort = Number(local.split(":")[1])
  const manager = new RemoteProxySessionManager({ authManager, logger: log, httpsOptions: tls })
  t.after(() => manager.shutdown())
  const { sessionId, windowUrl } = await manager.createSession(target, true)
  const location = new URL(windowUrl)
  const options = { dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) }
  t.after(() => options.dispatcher.destroy())
  const post = await fetch(`${location.origin}/__codenomad/api/auth/token`, {
    ...options, method: "POST", headers: { origin: location.origin, "content-type": "application/json" },
    body: JSON.stringify({ token: decodeURIComponent(location.hash.slice(1)) }),
  })
  await post.text()
  assert.equal(post.status, 200)
  const voiceCookie = post.headers.getSetCookie()[0].split(";", 1)[0]
  await denied(location.host, gemini, { origin: location.origin, cookie: "codenomad_session=fake" }, 403, true)
  await denied(location.host, gemini, { origin: "null", cookie: voiceCookie }, 403, true)
  await denied(location.host, gemini, { origin: location.origin, cookie: voiceCookie }, 403, true)
  assert.equal(fake.connections.length, 0)
  const login = await fetch(`${location.origin}/api/auth/login`, {
    ...options, method: "POST", headers: { origin: location.origin, "content-type": "application/json" },
    body: JSON.stringify({ username: "codenomad", password: "local-password" }),
  })
  await login.text()
  assert.equal(login.status, 200)
  const loginCookie = login.headers.getSetCookie()[0].split(";", 1)[0]
  const headers = { origin: location.origin, cookie: `${voiceCookie}; ${loginCookie}` }
  await denied(location.host, gemini, { ...headers, cookie: `${headers.cookie}; malformed=%` }, 403, true)
  const client = connect(t, location.host, gemini, headers, true)
  const upstream = await setupGemini(client, fake)
  assert.deepEqual(await connect(t, location.host, gemini, headers, true).closed, [4000, "busy"])
  assert.equal(fake.connections.length, 1)
  await denied(location.host, "/elsewhere", headers, 404, true)
  assert(await manager.deleteSession(sessionId))
  assert.equal((await client.closed)[0], 1006)
  await upstream.closed
  assert(!logs.join("").includes(KEY))
})

test("fixed deadlines, message limits and provider errors never relay raw content", { timeout: 10000 }, async t => {
  const fake = await provider(t, { establishMs: 300, idleMs: 130, absoluteMs: 430 })
  const { log, logs } = logger()
  const { local } = await startRemoteSurface(t, { skipAuth: true, liveVoice: fake.gateway, logger: log })
  const headers = { origin: `http://${local}` }
  const start = (engine: LiveVoiceEngine = "gemini-live") => connect(t, local, liveVoiceTarget(engine), headers)
  const setupTimeout = start()
  const waiting = await fake.next()
  await waiting.next()
  assert.deepEqual(await setupTimeout.closed, [4000, "setup-timeout"])
  await waiting.closed

  const idle = start()
  const silent = await setupGemini(idle, fake)
  const heartbeats = setInterval(() => {
    idle.ws.ping()
    idle.send({ type: "audio", pcm: "AAAAAA==" })
    silent.send({ serverContent: { outputTranscription: { text: "Model output" } } })
  }, 25)
  try { assert.deepEqual(await idle.closed, [4000, "idle"]) } finally { clearInterval(heartbeats) }
  await silent.closed

  const limit = start()
  const active = await setupGemini(limit, fake)
  const activity = setInterval(() => active.send({ voiceActivity: { type: "ACTIVITY_START" } }), 35)
  try { assert.deepEqual(await limit.closed, [4000, "duration"]) } finally { clearInterval(activity) }
  await active.closed

  const invalid = start()
  const noRelay = await setupGemini(invalid, fake)
  invalid.send({ type: "session.update", session: { instructions: "untrusted", tools: [] } })
  assert.deepEqual(await invalid.closed, [4000, "invalid-message"])
  assert.deepEqual(noRelay.messages, [])
  await noRelay.closed

  const browserOversize = start()
  const browserOversizePeer = await setupGemini(browserOversize, fake)
  browserOversize.ws.send("x".repeat(LIVE_VOICE_CLIENT_BYTES + 1))
  assert([1006, 1009].includes((await browserOversize.closed)[0]))
  await browserOversizePeer.closed

  const upstreamOversize = start()
  const oversizedPeer = await setupGemini(upstreamOversize, fake)
  oversizedPeer.ws.send("x".repeat(LIVE_VOICE_PROVIDER_BYTES + 1))
  assert.deepEqual(await upstreamOversize.closed, [4000, "provider-error"])
  await oversizedPeer.closed

  const bad = start()
  const traceback = await setupGemini(bad, fake)
  traceback.send({ error: { message: `API key: ${KEY}` } })
  assert.deepEqual(await bad.closed, [4000, "provider-error"])
  assert.deepEqual(bad.messages, [])
  await traceback.closed
  const echo = start()
  const echoPeer = await setupGemini(echo, fake)
  echoPeer.send({ serverContent: { outputTranscription: { text: KEY } } })
  assert.deepEqual(await echo.closed, [4000, "provider-error"])
  assert.deepEqual(echo.messages, [])
  await echoPeer.closed
  assert(!logs.join("").includes(KEY))

  const away = start()
  const awayPeer = await setupGemini(away, fake)
  awayPeer.send({ goAway: { timeLeft: "5s" } })
  assert.deepEqual(await away.closed, [4000, "provider-disconnected"])
  await awayPeer.closed
  await delay(15)
  assert.equal(fake.connections.length, 9, "provider failure never reconnects")
})

test("direct and tunneled identities share four slots; a client disconnect releases its provider", { timeout: 10000 }, async t => {
  const fake = await provider(t)
  const { local, manager, target, authManager } = await startRemoteSurface(t, { liveVoice: fake.gateway })
  const origin = `http://${local}`
  const cookie = `${authManager.getCookieName()}=${authManager.createSession("codenomad").id}`
  const localClient = connect(t, local, gemini, { origin, cookie })
  const localProvider = await setupGemini(localClient, fake)
  function device() {
    const pairing = manager.createPairing()
    const token = manager.exchangePairing(new URL(pairing.url).hash.slice(1), undefined)!.token
    return { host: FAKE_TUNNEL_HOST, origin: `https://${FAKE_TUNNEL_HOST}`, cookie: `${DEVICE_COOKIE_NAME}=${token}` }
  }
  for (let i = 0; i < 3; i++) await setupGemini(connect(t, target(), gemini, device()), fake)
  const fifth = device()
  assert.deepEqual(await connect(t, target(), gemini, fifth).closed, [4000, "busy"])
  assert.equal(fake.connections.length, 4)
  localClient.send({ type: "stop" })
  assert.deepEqual(await localClient.closed, [1000, "stopped"])
  await localProvider.closed
  const reopened = connect(t, target(), gemini, fifth)
  const remote = await setupGemini(reopened, fake)
  reopened.ws.terminate()
  await remote.closed
  assert.equal(fake.connections.length, 5)
})

test("unexpected tools, odd-length audio, and faster-than-realtime streams terminate the voice socket", { timeout: 10000 }, async t => {
  const fake = await provider(t)
  const { local } = await startRemoteSurface(t, { liveVoice: fake.gateway, skipAuth: true })
  const start = () => connect(t, local, gemini, { origin: `http://${local}` })
  const badTool = start()
  const toolPeer = await setupGemini(badTool, fake)
  toolPeer.send({ toolCall: { functionCalls: [{ id: "outside", name: "read_file", args: { path: "sample" } }] } })
  assert.deepEqual(await badTool.closed, [4000, "provider-error"])
  assert.deepEqual(badTool.messages, [])
  await toolPeer.closed

  const invalidArgs = start()
  const invalidArgsPeer = await setupGemini(invalidArgs, fake)
  invalidArgsPeer.send({ toolCall: { functionCalls: [{ id: "unexpected", name: "get_recent_errors", args: { sessionId: "other" } }] } })
  assert.deepEqual(await invalidArgs.closed, [4000, "provider-error"])
  assert.deepEqual(invalidArgs.messages, [])
  await invalidArgsPeer.closed

  const badAudio = start()
  const oddPeer = await setupGemini(badAudio, fake)
  badAudio.send({ type: "audio", pcm: "AA==" })
  assert.deepEqual(await badAudio.closed, [4000, "invalid-message"])
  assert.deepEqual(oddPeer.messages, [])
  await oddPeer.closed

  const rapidAudio = start()
  const rapidPeer = await setupGemini(rapidAudio, fake)
  for (let i = 0; i < 3; i++) rapidAudio.send({ type: "audio", pcm: "A".repeat(28 * 1024) })
  assert.deepEqual(await rapidAudio.closed, [4000, "limit"])
  await rapidPeer.closed
})
