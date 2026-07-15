import assert from "node:assert/strict"
import { it } from "node:test"

it("applies and persists mutations buffered during a delayed failed clear", async () => {
  let rejectClear: ((error: Error) => void) | undefined
  let markClearStarted: (() => void) | undefined
  const clearStarted = new Promise<void>((resolve) => {
    markClearStarted = resolve
  })
  const savedSnapshots: any[] = []
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __CODENOMAD_RUNTIME_HOST__: "electron",
      __CODENOMAD_WINDOW_CONTEXT__: "local",
      localStorage: createMemoryStorage(),
      electronAPI: {
        claimClientStateAccess: async () => true,
        loadClientState: async () => ({
          isPrimary: true,
          restoreEnabled: true,
          snapshot: {
            version: 1,
            revision: 1,
            savedAt: 1,
            layout: {},
            session: { tabs: [{ kind: "sidecar", sidecarId: "saved" }], activeTabIndex: 0 },
          },
        }),
        saveClientState: async (_token: string, snapshot: unknown) => {
          savedSnapshots.push(snapshot)
          return true
        },
        clearClientState: () => {
          markClearStarted?.()
          return new Promise<boolean>((_resolve, reject) => {
            rejectClear = reject
          })
        },
      },
    },
  })

  const clientState = await import("./client-state.ts")
  await clientState.initializeClientState()

  const clearing = clientState.clearRestoredClientState()
  await clearStarted
  clientState.updateRestorableSession({ tabs: [{ kind: "sidecar", sidecarId: "buffered" }], activeTabIndex: 0 })
  clientState.writeClientLayoutValue("opencode-session-sidebar-width-v8", "410")
  assert.ok(rejectClear)
  rejectClear(new Error("native clear failed"))

  await assert.rejects(clearing, /native clear failed/)
  await clientState.flushClientState()

  assert.equal(savedSnapshots.length, 1)
  assert.equal(savedSnapshots[0].session.tabs[0].sidecarId, "buffered")
  assert.equal(savedSnapshots[0].layout["opencode-session-sidebar-width-v8"], "410")
})

function createMemoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key) },
    setItem: (key, value) => { values.set(key, String(value)) },
  }
}
