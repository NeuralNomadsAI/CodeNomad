import assert from "node:assert/strict"
import { it } from "node:test"

it("blocks captures before an in-flight clear reaches the native host", async () => {
  let finishClear: ((cleared: boolean) => void) | undefined
  let nativeSaveCount = 0
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
        saveClientState: async () => {
          nativeSaveCount += 1
          return true
        },
        clearClientState: () => new Promise<boolean>((resolve) => {
          finishClear = resolve
        }),
      },
    },
  })

  const clientState = await import("./client-state.ts")
  await clientState.initializeClientState()

  const clearing = clientState.clearRestoredClientState()
  clientState.updateRestorableSession({ tabs: [{ kind: "sidecar", sidecarId: "transient" }], activeTabIndex: 0 })
  await Promise.resolve()
  assert.ok(finishClear)
  finishClear(true)
  await clearing
  await clientState.flushClientState()

  assert.equal(clientState.loadedRestorableSession(), null)
  assert.equal(nativeSaveCount, 0)
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
