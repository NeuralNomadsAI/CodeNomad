import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { setImmediate } from "node:timers/promises"
import type { BrowserWindow, IpcMainInvokeEvent } from "electron"
import type { MicrophoneRequest, SpeechEngine } from "../../../desktop-speech/contract"
import { setupRemoteDictationIPC } from "./remote-dictation-ipc"
import { setupDeviceSpeechIPC } from "./device-speech-ipc"

const id = "c0de0001-1234-4567-8abc-0123456789ab"
const remoteBase = new URL("https://remote.example/path")
const proxy = new URL("https://127.0.0.1:4321/")
const local = "http://127.0.0.1:9948/"
const begin = { action: "begin", id, locale: "zh-Hant-TW" }

function fixtureWindow(id: number) {
  let destroyed = false
  let showCount = 0
  let targetUrl: string | undefined
  let openHandler: (() => unknown) | undefined
  let focused = true
  let resolveLoad!: () => void
  const load = new Promise<void>(resolve => { resolveLoad = resolve })
  const mainFrame = { url: "about:blank" }
  const contents = Object.assign(new EventEmitter(), {
    id, mainFrame, getURL: () => mainFrame.url, isDestroyed: () => destroyed,
    setWindowOpenHandler: (handler: () => unknown) => { openHandler = handler },
  })
  const raw = Object.assign(new EventEmitter(), {
    webContents: contents, isDestroyed: () => destroyed, isFocused: () => focused,
    loadURL: (url: string) => { targetUrl = url; return load },
    show: () => { showCount++ },
    destroy: () => {
      if (destroyed) return
      destroyed = true
      contents.emit("destroyed")
      raw.emit("closed")
    },
  })
  function commit(url: string) {
    contents.emit("did-start-navigation", { url, isMainFrame: true, isSameDocument: false })
    // Deliberately reuse the frame object across distinct documents.
    mainFrame.url = url
    contents.emit("did-navigate", {}, url)
  }
  return {
    window: raw as unknown as BrowserWindow, contents, raw, commit,
    event: (senderFrame = mainFrame) => ({ sender: contents, senderFrame }) as unknown as IpcMainInvokeEvent,
    blur: () => { focused = false },
    target: () => targetUrl!,
    showCount: () => showCount,
    open: () => openHandler!(),
    ready: async () => { commit(targetUrl!); resolveLoad(); await Promise.resolve() },
    resolveLoad,
  }
}

function fixture() {
  const opener = fixtureWindow(1)
  const other = fixtureWindow(2)
  let choice: SpeechEngine | null = "hex"
  let localUrl: string | null = local
  let stopping = false
  let dialog = fixtureWindow(3)
  let settings = 0
  let reads = 0
  const revocations: number[] = []
  const microphoneRequests: Array<[number, MicrophoneRequest]> = []
  const microphoneRevocations: number[] = []
  const actions: string[] = []
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>()
  const ipc = { handle: (name: string, handler: (event: IpcMainInvokeEvent, input: unknown) => unknown) => handlers.set(name, handler) }
  const bridge = setupRemoteDictationIPC(ipc, {
    resolveRemote: sender => [opener, other].find(window => window.window.webContents === sender)?.window,
    localUrl: () => localUrl,
    readChoice: () => { reads++; return choice },
    createDialog: parent => {
      assert.equal(parent, opener.window)
      dialog = fixtureWindow(3)
      return dialog.window
    },
    revokeSpeech: owner => revocations.push(owner),
    rendererMicrophone: {
      request(owner, input) {
        microphoneRequests.push([owner, input])
        return { ok: true, value: input.action === "claimMicrophone" ? { busy: "test" } : null }
      },
      revokeRendererMicrophone: owner => microphoneRevocations.push(owner),
    },
    openSpeechPreferences: async () => { settings++ },
    isShuttingDown: () => stopping,
  })
  setupDeviceSpeechIPC(ipc, {
    request: (_owner, input) => { actions.push(input.action); return { ok: true, value: null } },
    revoke: () => {}, revokeAll: async () => {}, revokeRendererMicrophone: () => {},
  }, {
    resolveLocal: () => undefined,
    resolvePreferences: () => undefined,
    resolveDictation: bridge.requireDialog,
    getAllowedOrigins: () => ["http://localhost:9999"], // Dedicated dialog uses its own exact origin.
  })
  for (const window of [opener, other]) {
    bridge.observeRemote(window.window)
    bridge.setRemoteTarget(window.window, proxy, remoteBase)
    window.commit(proxy.href)
  }
  return {
    opener, other, bridge, dialog: () => dialog,
    request: handlers.get("remote-dictation:request")!,
    settle: (event: IpcMainInvokeEvent, value: unknown) => handlers.get("remote-dictation:settle")!(event, value) as Promise<null>,
    speech: handlers.get("device-speech:request")!,
    choice: (value: SpeechEngine | null) => { choice = value },
    localUrl: (url: string | null) => { localUrl = url },
    shutdown: () => { stopping = true; bridge.revoke() },
    settings: () => settings, revocations, reads: () => reads, actions,
    microphoneRequests, microphoneRevocations,
  }
}

test("remote dictation is exact-origin primary-frame only, validates fields, and reads only the device choice", () => {
  const f = fixture()
  assert.equal(f.request(f.opener.event(), { action: "read" }), "hex")
  assert.equal(f.reads(), 1)
  assert.throws(() => f.request(fixtureWindow(7).event(), { action: "read" }), /registered remote window/)
  assert.throws(() => f.request(f.opener.event({ url: proxy.href }), { action: "read" }), /registered main frame/)
  for (const value of [
    { action: "read", probe: true }, { ...begin, audio: "" }, { ...begin, locale: "en_US" },
    { ...begin, id: id.toUpperCase() }, { ...begin, id: id.replace("-4567-", "-1567-") },
    { ...begin, id: `${id}\n` }, { action: "cancel", id, workspaceId: "foreign" },
  ]) assert.throws(() => f.request(f.opener.event(), value), /Invalid remote dictation request/)
  assert.equal(f.reads(), 1)
  f.opener.commit(remoteBase.href)
  assert.throws(() => f.request(f.opener.event(), { action: "read" }), /registered remote window/)
})

test("remote microphone requests share host arbitration and retire on committed document loss", () => {
  const f = fixture()
  const claim = { action: "claimMicrophone", id, purpose: "conversation" }
  const release = { action: "releaseMicrophone", id }
  assert.deepEqual(f.request(f.opener.event(), claim), { ok: true, value: { busy: "test" } })
  assert.throws(() => f.request(f.opener.event({ url: proxy.href }), claim), /registered main frame/)
  assert.throws(() => f.request(f.opener.event(), { ...claim, target: "other-window" }), /secure remote/)
  f.opener.blur()
  assert.throws(() => f.request(f.opener.event(), claim), /secure remote/)
  assert.deepEqual(f.request(f.opener.event(), release), { ok: true, value: null })
  assert.deepEqual(f.microphoneRequests, [[1, claim], [1, release]])
  f.microphoneRevocations.length = 0
  f.opener.contents.emit("did-start-navigation", { url: proxy.href, isMainFrame: true, isSameDocument: false })
  assert.deepEqual(f.microphoneRevocations, [])
  assert.throws(() => f.request(f.opener.event(), claim), /registered remote window/)
  f.opener.commit(new URL("/sidecars/fixture", proxy).href)
  assert.deepEqual(f.microphoneRevocations, [1])
  assert.throws(() => f.request(f.opener.event(), release), /secure remote/)
})

test("admission requires a focused remote opener, device mode, live local backend and no shutdown", () => {
  const f = fixture()
  f.choice("api")
  assert.throws(() => f.request(f.opener.event(), begin), /unavailable/)
  f.choice("hex")
  for (const url of [null, "http://127.0.0.1:9948/login", "http://127.0.0.1.example:9948/"]) {
    f.localUrl(url)
    assert.throws(() => f.request(f.opener.event(), begin), /Local CodeNomad is unavailable/)
  }
  f.opener.blur()
  assert.throws(() => f.request(f.opener.event(), begin), /Remote dictation is unavailable/)
  f.shutdown()
  assert.throws(() => f.request(f.opener.event(), begin), /shutting down/)
})

test("an unsupported saved engine cannot open the dictation sheet", () => {
  const f = fixture()
  f.choice(null)
  assert.equal(f.request(f.opener.event(), { action: "read" }), null)
  assert.throws(() => f.request(f.opener.event(), begin), /Remote dictation is unavailable/)
  assert.equal(f.dialog().target(), undefined)
  f.choice("hex")
  assert.equal(f.request(f.opener.event(), { action: "read" }), "hex")
})

test("failed remote reuse restores only the unchanged original document and never its cancelled dialog", async () => {
  const f = fixture()
  const result = f.request(f.opener.event(), begin)
  const otherOrigin = new URL("https://new.example")
  const restore = f.bridge.setRemoteTarget(f.opener.window, otherOrigin, otherOrigin)
  assert.equal(await result, null)
  assert.throws(() => f.request(f.opener.event(), { action: "read" }), /registered remote window/)
  restore()
  assert.equal(f.request(f.opener.event(), { action: "read" }), "hex")
  assert.deepEqual(f.revocations, [3])
  await setImmediate()
  const next = f.request(f.opener.event(), begin)
  assert.equal(new URL(f.dialog().target()).hash, "#dictationDestination=https%3A%2F%2Fremote.example")
  f.bridge.revoke()
  assert.equal(await next, null)
})

test("failed reuse cannot restore the original document once a navigation has started", () => {
  const f = fixture()
  const otherOrigin = new URL("https://new.example")
  const restore = f.bridge.setRemoteTarget(f.opener.window, otherOrigin, otherOrigin)
  // Chromium can leave the prior URL and frame visible when a started load fails.
  f.opener.contents.emit("did-start-navigation", { url: otherOrigin.href, isMainFrame: true, isSameDocument: false })
  restore()
  assert.throws(() => f.request(f.opener.event(), { action: "read" }), /registered remote window/)
})

test("only the exact local dialog can use composer speech or settle bounded text; destination is the registered base", async () => {
  const f = fixture()
  const result = f.request(f.opener.event(), begin)
  const dialog = f.dialog()
  const url = new URL(dialog.target())
  assert.equal(url.origin, new URL(local).origin)
  assert.equal(url.searchParams.get("dictationLocale"), begin.locale)
  assert.equal(url.hash, "#dictationDestination=https%3A%2F%2Fremote.example")
  assert.deepEqual(dialog.open(), { action: "deny" })
  assert.throws(() => f.request(f.opener.event(), begin), /unavailable/)
  await assert.rejects(f.settle(dialog.event(), { action: "cancel" }), /not active/)
  await dialog.ready()
  assert.equal(dialog.showCount(), 1)
  await assert.rejects(f.settle(f.opener.event(), { action: "complete", text: "foreign" }), /local dialog/)
  await assert.rejects(f.settle(dialog.event({ url: url.href }), { action: "cancel" }), /not active/)
  assert.throws(() => f.speech(f.opener.event(), { action: "read" }), /local application window/)
  assert.throws(() => f.speech(dialog.event(), { action: "select", engine: "hex" }), /Preferences/)
  assert.throws(() => f.speech(dialog.event(), { action: "prepare", planId: "valid" }), /Preferences/)
  assert.deepEqual(f.actions, [], "opening the dialog never starts device speech")
  for (const value of [
    { action: "read" }, { action: "start", locale: begin.locale }, { action: "status", id },
    { action: "finish", id, wav: "UklGRiYAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQIAAAAAAA==" }, { action: "cancel", id },
  ]) f.speech(dialog.event(), value)
  assert.deepEqual(f.actions, ["read", "start", "status", "finish", "cancel"])
  assert.deepEqual(f.bridge.mediaOrigins(dialog.window.webContents, true, true), [url.origin])
  assert.deepEqual(f.bridge.mediaOrigins(dialog.window.webContents, false, true), [])
  assert.deepEqual(f.bridge.mediaOrigins(dialog.window.webContents, true, false), [])
  await assert.rejects(f.settle(dialog.event(), { action: "complete", text: "é".repeat(32769) }), /Invalid/)
  await assert.rejects(f.settle(dialog.event(), { action: "cancel", text: "unused" }), /Invalid/)
  const text = "é".repeat(32768)
  assert.equal(await f.settle(dialog.event(), { action: "complete", text }), null)
  assert.equal(await result, text)
  assert.deepEqual(f.revocations, [3])
  await assert.rejects(f.settle(dialog.event(), { action: "settings" }), /local dialog/)
  await setImmediate()
  assert.equal(dialog.window.isDestroyed(), true)
})

test("a begin reserves synchronously; only the requesting document and exact ID cancel it", async () => {
  const f = fixture()
  const result = f.request(f.opener.event(), begin)
  const dialog = f.dialog()
  assert.equal(f.request(f.other.event(), { action: "cancel", id }), null)
  assert.equal(f.request(f.opener.event(), { action: "cancel", id: id.replace("0001", "0002") }), null)
  assert.deepEqual(f.revocations, [])
  assert.equal(f.request(f.opener.event(), { action: "cancel", id }), null)
  assert.equal(await result, null)
  await dialog.ready() // An already queued completion of load cannot show the revoked dialog.
  assert.equal(dialog.showCount(), 0)
  assert.deepEqual(f.revocations, [3])
})

test("opening Speech Preferences cancels the requesting dialog before opening local settings", async () => {
  const f = fixture()
  const result = f.request(f.opener.event(), begin)
  await f.dialog().ready()
  assert.equal(await f.settle(f.dialog().event(), { action: "settings" }), null)
  assert.equal(await result, null)
  assert.deepEqual(f.revocations, [3])
  assert.equal(f.settings(), 1)
})

test("navigation, close, crash and shutdown revoke the pending dialog and its speech owner", async t => {
  const cases: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    ["same-origin remote reload", f => f.opener.commit(proxy.href)],
    ["remote close", f => f.opener.raw.emit("close")],
    ["remote destruction", f => f.opener.raw.destroy()],
    ["remote crash", f => f.opener.contents.emit("render-process-gone")],
    ["trusted reload", f => f.dialog().commit(f.dialog().target())],
    ["trusted destruction", f => f.dialog().raw.destroy()],
    ["trusted crash", f => f.dialog().contents.emit("render-process-gone")],
    ["trusted hide", f => f.dialog().raw.emit("hide")],
    ["trusted navigation attempt", f => {
      let prevented = false
      f.dialog().contents.emit("will-frame-navigate", { preventDefault: () => { prevented = true } })
      assert.equal(prevented, true)
    }],
    ["shutdown", f => f.shutdown()],
  ]
  for (const [label, trigger] of cases) await t.test(label, async () => {
    const f = fixture()
    const result = f.request(f.opener.event(), begin)
    await f.dialog().ready()
    trigger(f)
    assert.equal(await result, null)
    assert.deepEqual(f.revocations, [3])
    await assert.rejects(f.settle(f.dialog().event(), { action: "complete", text: "old" }), /local dialog/)
    await setImmediate()
    assert.equal(f.dialog().window.isDestroyed(), true)
  })
})
