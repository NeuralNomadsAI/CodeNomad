import assert from "node:assert/strict"
import test from "node:test"
import type { BrowserWindow, IpcMainInvokeEvent } from "electron"
import { setupDataProfileCleanupIPC } from "./data-profile-cleanup-ipc"

function setup(overrides: { setNextLaunchProfile?: (...args: unknown[]) => Promise<{ outcome: "updated" }> } = {}) {
  const handlers = new Map<string, Function>()
  const calls: unknown[] = []
  const frame = { url: "http://localhost:3000/" }
  const contents = { mainFrame: frame, getURL: () => frame.url }
  const window = { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow
  const roots = { electronBase: "e", webviewRoot: "w", tauriDataParent: "t", homeClientState: "h" }
  const current = { key: "dev", configIdentity: "c", defaultIdentity: "c", pinned: false }
  const listing = { current: { name: "dev", sizeBytes: 0, sizeComplete: true, createdAt: null, lastUsedAt: null }, profiles: [], nextLaunch: null, pinned: false, sharedWebKitStorage: false }
  setupDataProfileCleanupIPC({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    resolveWindow: (sender) => sender === contents ? window : undefined,
    getAllowedOrigins: () => ["http://localhost:3000"],
    roots: () => roots,
    current: () => current,
    relaunch: () => { calls.push(["relaunch"]) },
    operations: {
      listOtherProfiles: async (...args) => { calls.push(["list", ...args]); return listing },
      deleteOtherProfiles: async (...args) => { calls.push(["delete", ...args]); return { results: [], choices: "unchanged" } },
      setNextLaunchProfile: overrides.setNextLaunchProfile ?? (async (...args) => { calls.push(["next", ...args]); return { outcome: "updated" } }),
    },
  })
  const event = (sender: object, senderFrame: object = frame) => ({ sender, senderFrame }) as IpcMainInvokeEvent
  return { handlers, calls, contents, frame, roots, current, listing, event }
}

test("data-profile IPC accepts local and Preferences windows only and forwards validated IDs", async () => {
  const { handlers, calls, contents, frame, roots, current, listing, event } = setup()

  assert.deepEqual(await handlers.get("data-profiles:listOthers")!(event(contents)), listing)
  await handlers.get("data-profiles:deleteOthers")!(event(contents), ["default", "default"])
  assert.deepEqual(calls, [["list", roots, current], ["delete", roots, current, ["default"]]])

  assert.throws(() => handlers.get("data-profiles:listOthers")!(event({ mainFrame: frame })), /local application windows/)
  assert.throws(() => handlers.get("data-profiles:listOthers")!(event(contents, { url: "http://localhost:3000/frame" })), /main frame/)
  assert.throws(() => handlers.get("data-profiles:deleteOthers")!(event(contents), ["C:\\Users"]), /Invalid profile identifier/)
  assert.equal(calls.length, 2)
})

test("choosing the next launch's profile and relaunching share the sender checks", async () => {
  const { handlers, calls, contents, frame, roots, current, event } = setup()
  assert.deepEqual(await handlers.get("data-profiles:setNextLaunch")!(event(contents), "Team"), { outcome: "updated" })
  // The name is validated host-side by the operation, never trusted as a path.
  await handlers.get("data-profiles:setNextLaunch")!(event(contents), { path: "C:\\" })
  await handlers.get("data-profiles:relaunch")!(event(contents))
  assert.deepEqual(calls, [["next", roots, current, "Team"], ["next", roots, current, { path: "C:\\" }], ["relaunch"]])

  for (const channel of ["data-profiles:setNextLaunch", "data-profiles:relaunch"]) {
    assert.throws(() => handlers.get(channel)!(event({ mainFrame: frame }), "dev"), /local application windows/, channel)
    assert.throws(() => handlers.get(channel)!(event(contents, { url: "http://localhost:3000/frame" }), "dev"), /main frame/, channel)
  }
  assert.equal(calls.length, 3)
})

test("a relaunch waits for a profile choice still being written", async () => {
  let finish!: () => void
  const { handlers, calls, contents, event } = setup({
    setNextLaunchProfile: () => new Promise((resolve) => { finish = () => { calls.push(["next"]); resolve({ outcome: "updated" }) } }),
  })
  const choosing = handlers.get("data-profiles:setNextLaunch")!(event(contents), "team")
  const relaunching = handlers.get("data-profiles:relaunch")!(event(contents))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(calls, [])
  finish()
  await Promise.all([choosing, relaunching])
  assert.deepEqual(calls, [["next"], ["relaunch"]])
})
