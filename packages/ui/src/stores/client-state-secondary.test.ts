import assert from "node:assert/strict"
import { it } from "node:test"

class MemoryStorage {
  private readonly values = new Map<string, string>()

  get length() { return this.values.size }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, String(value)) }
}

it("keeps secondary-process layout local without hydrating or writing native snapshots", async () => {
  const storage = new MemoryStorage()
  let nativeSaveCount = 0
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __CODENOMAD_RUNTIME_HOST__: "electron",
      __CODENOMAD_WINDOW_CONTEXT__: "local",
      localStorage: storage,
      electronAPI: {
        claimClientStateAccess: async () => true,
        loadClientState: async () => ({
          isPrimary: false,
          restoreEnabled: true,
          snapshot: {
            version: 1,
            revision: 4,
            savedAt: 100,
            layout: { "opencode-session-sidebar-width-v8": "380" },
            session: { tabs: [{ kind: "sidecar", sidecarId: "docs" }], activeTabIndex: 0 },
          },
        }),
        saveClientState: async () => {
          nativeSaveCount += 1
          return false
        },
      },
    },
  })

  const clientState = await import("./client-state.ts")
  await clientState.initializeClientState()

  assert.equal(clientState.clientStateIsPrimary(), false)
  assert.equal(clientState.loadedRestorableSession(), null)
  assert.equal(clientState.readClientLayoutValue("opencode-session-sidebar-width-v8"), null)

  clientState.writeClientLayoutValue("opencode-session-sidebar-width-v8", "340")
  clientState.updateRestorableSession({ tabs: [{ kind: "sidecar", sidecarId: "other" }], activeTabIndex: 0 })
  await clientState.flushClientState()

  assert.equal(storage.getItem("opencode-session-sidebar-width-v8"), "340")
  assert.equal(nativeSaveCount, 0)
})
