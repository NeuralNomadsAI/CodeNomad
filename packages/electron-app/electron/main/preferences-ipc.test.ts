import assert from "node:assert/strict"
import test from "node:test"
import type { BrowserWindow, IpcMainInvokeEvent } from "electron"
import { setupPreferencesIPC } from "./preferences-ipc"

function harness() {
  const handlers = new Map<string, Function>()
  const calls: string[] = []
  const frame = { url: "http://localhost:3000/preferences" }
  let maximized = false
  const preferencesContents = { id: 2, mainFrame: frame, getURL: () => frame.url }
  const localContents = { id: 1, mainFrame: frame, getURL: () => frame.url }
  const preferencesWindow = {
    webContents: preferencesContents,
    isDestroyed: () => false,
    minimize: () => calls.push("minimize"),
    isMaximized: () => maximized,
    maximize: () => { maximized = true; calls.push("maximize") },
    unmaximize: () => { maximized = false; calls.push("unmaximize") },
    close: () => calls.push("close"),
  } as unknown as BrowserWindow
  const localWindow = {
    webContents: localContents,
    isDestroyed: () => false,
    minimize: () => calls.push("local:minimize"),
  } as unknown as BrowserWindow
  setupPreferencesIPC(
    { handle: (channel, handler) => handlers.set(channel, handler) },
    {
      resolveLocal: (sender) => sender === localContents ? { window: localWindow } : undefined,
      resolvePreferences: (sender) => sender === preferencesContents ? preferencesWindow : undefined,
      getAllowedOrigins: () => ["http://localhost:3000"],
      openPreferences: async (request, toggle) => { calls.push(`open:${request.section}:${request.instanceId ?? ""}:${Boolean(toggle)}`) },
      getRequest: () => ({ section: "speech" }),
      markReady: () => { calls.push("ready") },
      acceptRequest: (_window, request) => { calls.push(`accept:${request.section}`) },
      resolveTransition: (_window, id, approved) => { calls.push(`transition:${id}:${approved}`) },
      approveClose: (window) => { calls.push("approve"); window.close() },
    },
  )
  const event = (sender: object, senderFrame = frame) => ({ sender, senderFrame }) as IpcMainInvokeEvent
  return { handlers, calls, frame, localContents, preferencesContents, event }
}

test("Preferences IPC separates local open authority and controls registered app windows", async () => {
  const h = harness()
  assert.deepEqual([...h.handlers.keys()], [
    "preferences:open", "preferences:getSection", "preferences:ready", "preferences:acceptRequest", "preferences:resolveTransition", "preferences:minimize", "preferences:toggleMaximize", "preferences:close",
  ])

  assert.deepEqual(await h.handlers.get("preferences:open")!(h.event(h.localContents), "speech", { instanceId: "workspace-1" }, true), { ok: true })
  await assert.rejects(h.handlers.get("preferences:open")!(h.event(h.preferencesContents), "speech"), /local window/)
  await assert.rejects(h.handlers.get("preferences:open")!(h.event(h.localContents), "workspace"), /Invalid preferences section/)

  assert.deepEqual(h.handlers.get("preferences:getSection")!(h.event(h.preferencesContents)), { section: "speech" })
  assert.deepEqual(h.handlers.get("preferences:ready")!(h.event(h.preferencesContents)), { ok: true })
  assert.deepEqual(await h.handlers.get("preferences:acceptRequest")!(h.event(h.preferencesContents), { section: "providers" }), { ok: true })
  assert.deepEqual(h.handlers.get("preferences:resolveTransition")!(h.event(h.preferencesContents), 3, false), { ok: true })
  assert.deepEqual(h.handlers.get("preferences:minimize")!(h.event(h.preferencesContents)), { ok: true })
  assert.deepEqual(h.handlers.get("preferences:minimize")!(h.event(h.localContents)), { ok: true })
  assert.deepEqual(h.handlers.get("preferences:toggleMaximize")!(h.event(h.preferencesContents)), { maximized: true })
  assert.deepEqual(h.handlers.get("preferences:toggleMaximize")!(h.event(h.preferencesContents)), { maximized: false })
  assert.deepEqual(await h.handlers.get("preferences:close")!(h.event(h.preferencesContents)), { ok: true })
  assert.deepEqual(h.calls, ["open:speech:workspace-1:true", "ready", "accept:providers", "transition:3:false", "minimize", "local:minimize", "maximize", "unmaximize", "approve", "close"])
})

test("Preferences IPC rejects unregistered, subframe, and cross-origin senders", () => {
  const h = harness()
  const minimize = h.handlers.get("preferences:minimize")!
  assert.throws(() => minimize(h.event({})), /local application windows/)
  assert.throws(() => minimize(h.event(h.preferencesContents, { url: h.frame.url })), /registered main frame/)
  h.frame.url = "https://outside.example/preferences"
  assert.throws(() => minimize(h.event(h.preferencesContents)), /allowed renderer origin/)
})
