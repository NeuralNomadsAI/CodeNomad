import assert from "node:assert/strict"
import { it } from "node:test"

it("preserves retry dirt from an in-flight failed save when native clear throws", async () => {
  let rejectFirstSave: ((error: Error) => void) | undefined
  let markFirstSaveStarted: (() => void) | undefined
  const firstSaveStarted = new Promise<void>((resolve) => {
    markFirstSaveStarted = resolve
  })
  const savedSnapshots: unknown[] = []
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __CODENOMAD_RUNTIME_HOST__: "electron",
      __CODENOMAD_WINDOW_CONTEXT__: "local",
      localStorage: createMemoryStorage(),
      electronAPI: {
        claimClientStateAccess: async () => true,
        loadClientState: async () => ({ isPrimary: true, restoreEnabled: true, snapshot: null }),
        saveClientState: (_token: string, snapshot: unknown) => {
          savedSnapshots.push(snapshot)
          if (savedSnapshots.length > 1) return Promise.resolve(true)
          markFirstSaveStarted?.()
          return new Promise<boolean>((_resolve, reject) => {
            rejectFirstSave = reject
          })
        },
        clearClientState: async () => {
          throw new Error("native clear failed")
        },
      },
    },
  })

  const clientState = await import("./client-state.ts")
  await clientState.initializeClientState()
  clientState.updateRestorableSession({ tabs: [{ kind: "sidecar", sidecarId: "retry" }], activeTabIndex: 0 })

  const firstFlush = clientState.flushClientState()
  await firstSaveStarted
  const clearing = clientState.clearRestoredClientState()
  assert.ok(rejectFirstSave)
  rejectFirstSave(new Error("first save failed"))

  await assert.rejects(firstFlush, /first save failed/)
  await assert.rejects(clearing, /native clear failed/)
  await clientState.flushClientState()

  assert.equal(savedSnapshots.length, 2)
  assert.equal((savedSnapshots[1] as any).session.tabs[0].sidecarId, "retry")
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
