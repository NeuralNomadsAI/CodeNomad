import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { registerHooks } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import type { BrowserWindow, IpcMainInvokeEvent, Session, WebContents } from "electron"
import { isDeviceSpeechRequest } from "../../../desktop-speech/contract"
import vectors from "../../../desktop-speech/request-vectors.json"
import { DeviceSpeech, DeviceSpeechPreference, type DeviceSpeechDriver, type SpeechOperationControl } from "./device-speech"
import { setupDeviceSpeechIPC } from "./device-speech-ipc"

test("an unused remote microphone reservation expires; an authorized one stays held until revocation", t => {
  let now = 0
  const { device } = fixture(t, undefined, () => now)
  const claim = (owner: number, remote = false) => device.request(owner, {
    action: "claimMicrophone", id: "c2d420ea-2677-4dbd-a521-92435a6ba004", purpose: "dictation",
  }, remote)
  assert.deepEqual(claim(1, true), { ok: true, value: { busy: null } })
  assert.deepEqual(claim(2), { ok: true, value: { busy: "dictation" } })
  device.authorizeRendererMicrophone(2)
  now = 10_000
  assert.deepEqual(claim(2, true), { ok: true, value: { busy: null } })
  device.authorizeRendererMicrophone(2)
  now = 20_000
  assert.deepEqual(claim(1), { ok: true, value: { busy: "dictation" } })
  device.revokeRendererMicrophone(2)
  assert.deepEqual(claim(1), { ok: true, value: { busy: null } })
})

test("a remote microphone permission request cannot grant a reservation expired during system consent", async t => {
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "electron") return {
        shortCircuit: true,
        url: "data:text/javascript,export const BrowserWindow={},desktopCapturer={},dialog={},session={},systemPreferences={},webContents={}",
      }
      return next(specifier, context)
    },
  })
  t.after(() => hooks.deregister())
  const { configureMediaPermissionHandlers } = await import("./permissions")
  let now = 0
  const { device } = fixture(t, undefined, () => now)
  const claim = (owner: number) => device.request(owner, {
    action: "claimMicrophone", id: "c2d420ea-2677-4dbd-a521-92435a6ba004", purpose: "conversation",
  }, true)
  const origin = "https://remote.example"
  let handler!: NonNullable<Parameters<Session["setPermissionRequestHandler"]>[0]>
  const session = {
    setPermissionCheckHandler() {},
    setPermissionRequestHandler(callback: typeof handler) { handler = callback },
  } as unknown as Session
  configureMediaPermissionHandlers(() => [origin], session, undefined, contents => device.authorizeRendererMicrophone(contents.id))
  const request = (id: number) => {
    let granted: boolean | undefined
    handler({ id, getURL: () => origin } as WebContents, "media", result => { granted = result }, {
      requestingUrl: origin, isMainFrame: true, mediaTypes: ["audio"],
    })
    return granted
  }

  assert.deepEqual(claim(1), { ok: true, value: { busy: null } })
  now = 11_000
  assert.equal(request(1), false)
  assert.deepEqual(claim(2), { ok: true, value: { busy: null } })
  assert.equal(request(1), false)
  assert.equal(request(2), true)
  now += 11_000
  assert.deepEqual(claim(1), { ok: true, value: { busy: "conversation" } })
})

function fixture(t: TestContext, hexDriver?: DeviceSpeechDriver, now?: () => number) {
  const directory = mkdtempSync(join(tmpdir(), "codenomad-speech-"))
  const path = join(directory, "choice.json")
  const preference = new DeviceSpeechPreference(path)
  const device = new DeviceSpeech(preference, hexDriver, now)
  t.after(() => { device.revokeAll(); rmSync(directory, { recursive: true, force: true }) })
  return { device, preference, path }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const busy = { ok: false, error: "busy" }
const notOwned = { ok: false, error: "notOwned" }

test("device speech parses the shared native wire vectors", () => {
  for (const { request, valid } of vectors) assert.equal(isDeviceSpeechRequest(request), valid, JSON.stringify(request))
})

test("an unsupported saved engine blocks native capture until explicit reselection", t => {
  const { device, preference, path } = fixture(t)
  const saved = JSON.stringify({ version: 1, engine: "unsupported", revision: "c2d420ea-2677-4dbd-a521-92435a6ba004" })
  writeFileSync(path, saved)
  assert.deepEqual(device.request(1, { action: "read" }), { ok: true, value: {
    engine: null, hex: { state: "unavailable" },
  } })
  assert.deepEqual(device.request(1, { action: "start", locale: "en" }), { ok: false, error: "unavailable" })
  assert.equal(readFileSync(path, "utf8"), saved)
  assert.equal(device.request(1, { action: "select", engine: "api" }).ok, true)
  assert.equal(preference.read().engine, "api")
})

test("microphone reservations compete across owners and native dictation stays busy through driver shutdown", async (t) => {
  let finish!: (text: string) => void
  const { device, preference } = fixture(t, {
    capabilities: () => ({ hex: { state: "ready", plan: { id: "ready", missing: [] } } }),
    prepare: async () => {},
    dictate: () => new Promise(resolve => { finish = resolve }),
  })
  assert.equal(preference.select("hex"), undefined)
  const id = "c0de0001-1234-4567-8abc-0123456789ab"
  const claim = (owner: number, purpose: "test" | "dictation" | "conversation") =>
    device.request(owner, { action: "claimMicrophone", id, purpose })
  const release = (owner: number) => device.request(owner, { action: "releaseMicrophone", id })
  const occupied = (busy: string | null) => ({ ok: true, value: { busy } })
  assert.deepEqual(claim(1, "test"), occupied(null))
  assert.deepEqual(claim(2, "conversation"), occupied("test"))
  assert.deepEqual(device.request(2, { action: "start", locale: "en-US" }), busy)
  release(2)
  device.revoke(1, false)
  assert.deepEqual(claim(2, "dictation"), occupied("test"), "the old document can still be closing")
  device.revokeRendererMicrophone(1)
  assert.deepEqual(claim(2, "dictation"), occupied(null))
  const start = device.request(2, { action: "start", engine: "hex", locale: "en-US", microphoneLeaseId: id })
  assert.ok(start.ok && start.value && "id" in start.value)
  await tick()
  device.revoke(2)
  assert.deepEqual(claim(3, "conversation"), occupied("dictation"))
  finish("discarded")
  await tick()
  assert.deepEqual(claim(3, "conversation"), occupied(null))
})

test("unconfigured desktop preserves API; only supported choices can be written", (t) => {
  const { device, preference, path } = fixture(t)
  assert.deepEqual(device.request(1, { action: "read" }), {
    ok: true, value: { engine: "api", hex: { state: "unavailable" } },
  })
  assert.deepEqual(device.request(1, { action: "select", engine: "hex" }), { ok: false, error: "unavailable" })
  assert.equal(preference.select("api"), undefined)
  const { revision } = preference.read()
  assert.equal(new DeviceSpeechPreference(path).read().revision, revision)
  assert.equal(preference.select("api"), undefined)
  assert.equal(preference.select("hex", revision), "planChanged")
  assert.equal(preference.read().engine, "api")
  writeFileSync(path, " ".repeat(257))
  assert.deepEqual(device.request(1, { action: "read" }), { ok: false, error: "failed" })
})

test("one owner prepares the exact current plan; cancellation waits for the driver and keeps selection", async (t) => {
  const pending: { control: SpeechOperationControl; finish: () => void }[] = []
  const download = { id: "download", missing: [{ component: "engine", downloadBytes: 12 }] } as const
  const ready = { id: "ready", missing: [] }
  let prepared = false
  const { device, preference } = fixture(t, {
    capabilities: () => ({ hex: prepared ? { state: "ready", plan: ready } : {
      state: "needsPreparation", plan: { id: download.id, missing: [...download.missing] },
    } }),
    prepare: (_plan, control) => new Promise<void>((finish) => pending.push({ control, finish })),
    dictate: async () => "",
  })
  assert.deepEqual(device.request(2, { action: "prepare", planId: "old" }), { ok: false, error: "planChanged" })
  const start = device.request(2, { action: "prepare", planId: download.id })
  assert.ok(start.ok && start.value && "id" in start.value)
  const id = start.value.id
  await tick()
  pending[0].control.progress({ state: "downloading", downloadedBytes: 5 })
  assert.deepEqual(device.request(9, { action: "status", id }), notOwned)
  assert.deepEqual(device.request(9, { action: "cancel", id }), notOwned)
  assert.deepEqual(device.request(2, { action: "status", id }), { ok: true, value: { state: "downloading", downloadedBytes: 5 } })
  assert.deepEqual(device.request(2, { action: "cancel", id }), { ok: true, value: null })
  assert.equal(pending[0].control.signal.aborted, true)
  assert.deepEqual(device.request(2, { action: "status", id }), { ok: true, value: { state: "stopping" } })
  assert.deepEqual(device.request(2, { action: "prepare", planId: download.id }), busy)
  pending[0].finish()
  await tick()
  assert.deepEqual(device.request(2, { action: "status", id }), { ok: true, value: { state: "cancelled" } })
  assert.equal(preference.read().engine, "api")

  const retry = device.request(2, { action: "prepare", planId: download.id })
  assert.ok(retry.ok && retry.value && "id" in retry.value)
  await tick()
  prepared = true
  pending[1].finish()
  await tick()
  assert.deepEqual(device.request(2, { action: "cancel", id: retry.value.id }), { ok: true, value: { state: "prepared" } })
  assert.deepEqual(device.request(2, { action: "status", id: retry.value.id }), notOwned)
  assert.equal(preference.read().engine, "hex")
  assert.ok(device.request(2, { action: "prepare", planId: ready.id }).ok)
  await tick()
  assert.equal(pending.length, 2, "zero missing components never invoke preparation")
})

test("only the initiating Hex capture can submit one canonical WAV", async (t) => {
  const wav = Buffer.from("524946462600000057415645666d74201000000001000100803e0000007d00000200100064617461020000000000", "hex")
  const observed: Buffer[] = []
  const { device } = fixture(t, {
    capabilities: () => ({ hex: { state: "ready", plan: { id: "ready", missing: [] } } }),
    prepare: async () => { assert.fail("already ready") },
    dictate: async control => {
      const audio = await control.waitForAudio()
      if (audio) observed.push(audio)
      return "bonjour"
    },
  })
  assert.equal(device.request(2, { action: "select", engine: "hex" }).ok, true)
  const start = device.request(1, { action: "start", engine: "hex", locale: "fr" })
  assert.ok(start.ok && start.value && "id" in start.value)
  const id = start.value.id
  const finish = { action: "finish", id, wav: wav.toString("base64") } as const
  assert.deepEqual(device.request(2, finish), notOwned)
  assert.deepEqual(device.request(1, { action: "finish", id, wav: Buffer.alloc(48).toString("base64") }), { ok: false, error: "failed" })
  assert.deepEqual(device.request(1, finish), { ok: true, value: null })
  assert.deepEqual(device.request(1, finish), busy)
  await tick()
  assert.deepEqual(observed, [wav])
  assert.deepEqual(device.request(1, { action: "status", id }), { ok: true, value: { state: "transcribed", text: "bonjour" } })
})

test("IPC verifies registered windows, action scope and origins; document loss revokes", (t) => {
  const { device } = fixture(t)
  const revoke = t.mock.method(device, "revoke")
  const allowed = "http://127.0.0.1:3000"
  const buildWindow = (id: number) => {
    const frame = { url: allowed }
    const contents = Object.assign(new EventEmitter(), { id, mainFrame: frame, getURL: () => frame.url })
    const event = (senderFrame = frame) => ({ sender: contents, senderFrame }) as unknown as IpcMainInvokeEvent
    const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false, isFocused: () => true }) as unknown as BrowserWindow
    return { contents, frame, event, window }
  }
  const local = buildWindow(1)
  const preferences = buildWindow(2)
  const remote = buildWindow(3)
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>()
  setupDeviceSpeechIPC({ handle: (name, handler) => handlers.set(name, handler) }, device, {
    resolveLocal: sender => sender === local.window.webContents ? local.window : undefined,
    resolvePreferences: sender => sender === preferences.window.webContents ? preferences.window : undefined,
    getAllowedOrigins: () => [allowed],
  })
  const request = handlers.get("device-speech:request")!
  assert.throws(() => request(remote.event(), { action: "read" }), /local application window/)
  assert.throws(() => request(local.event({ ...local.frame }), { action: "read" }), /registered main frame/)
  assert.throws(() => request(local.event(), { action: "prepare", planId: "plan" }), /Preferences window/)
  assert.throws(() => request(preferences.event(), { action: "start", locale: "fr" }), /composer window/)
  const id = "c0de0001-1234-4567-8abc-0123456789ab"
  assert.throws(() => request(preferences.event(), { action: "claimMicrophone", id, purpose: "conversation" }), /focused application window/)
  assert.deepEqual(request(preferences.event(), { action: "claimMicrophone", id, purpose: "test" }), { ok: true, value: { busy: null } })
  assert.deepEqual(request(local.event(), { action: "read" }), request(preferences.event(), { action: "read" }))
  preferences.frame.url = "http://127.0.0.1:9000"
  assert.throws(() => request(preferences.event(), { action: "read" }), /allowed renderer origin/)
  local.contents.emit("did-start-navigation", { isSameDocument: true, isMainFrame: true })
  local.contents.emit("did-start-navigation", { isSameDocument: false, isMainFrame: false })
  assert.equal(revoke.mock.callCount(), 0)
  local.contents.emit("did-start-navigation", { isSameDocument: false, isMainFrame: true })
  preferences.contents.emit("render-process-gone")
  assert.deepEqual(revoke.mock.calls.map(call => call.arguments), [[1, false], [2]])
})
