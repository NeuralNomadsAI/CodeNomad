import assert from "node:assert/strict"
import test from "node:test"
import type { BrowserWindow, IpcMainInvokeEvent } from "electron"
import { setupDataProfileCleanupIPC } from "./data-profile-cleanup-ipc"

test("data-profile IPC accepts local and Preferences windows only and forwards validated IDs", async () => {
  const handlers = new Map<string, Function>()
  const calls: unknown[] = []
  const frame = { url: "http://localhost:3000/" }
  const contents = { mainFrame: frame, getURL: () => frame.url }
  const window = { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow
  const roots = { electronBase: "e", webviewRoot: "w", tauriDataParent: "t", homeClientState: "h" }
  const current = { key: "dev", configIdentity: "c", defaultIdentity: "c" }
  setupDataProfileCleanupIPC({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    resolveWindow: (sender) => sender === contents ? window : undefined,
    getAllowedOrigins: () => ["http://localhost:3000"],
    roots: () => roots,
    current: () => current,
    operations: {
      listOtherProfiles: async (...args) => { calls.push(["list", ...args]); return { profiles: [] } },
      deleteOtherProfiles: async (...args) => { calls.push(["delete", ...args]); return { results: [], choices: "unchanged" } },
    },
  })
  const event = (sender: object, senderFrame: object = frame) => ({ sender, senderFrame }) as IpcMainInvokeEvent

  assert.deepEqual(await handlers.get("data-profiles:listOthers")!(event(contents)), { profiles: [] })
  await handlers.get("data-profiles:deleteOthers")!(event(contents), ["default", "default"])
  assert.deepEqual(calls, [["list", roots, current], ["delete", roots, current, ["default"]]])

  assert.throws(() => handlers.get("data-profiles:listOthers")!(event({ mainFrame: frame })), /local application windows/)
  assert.throws(() => handlers.get("data-profiles:listOthers")!(event(contents, { url: "http://localhost:3000/frame" })), /main frame/)
  assert.throws(() => handlers.get("data-profiles:deleteOthers")!(event(contents), ["C:\\Users"]), /Invalid profile identifier/)
  assert.equal(calls.length, 2)
})
