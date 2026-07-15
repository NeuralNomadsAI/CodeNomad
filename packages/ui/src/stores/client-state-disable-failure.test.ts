import assert from "node:assert/strict"
import { it } from "node:test"

it("rolls back and persists mutations buffered during a delayed failed disable", async () => {
  let rejectDisable: ((error: Error) => void) | undefined
  let markDisableStarted: (() => void) | undefined
  const disableStarted = new Promise<void>((resolve) => {
    markDisableStarted = resolve
  })
  const preferenceUpdates: boolean[] = []
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
        saveClientState: async (_token: string, snapshot: unknown) => {
          savedSnapshots.push(snapshot)
          return true
        },
        setClientStateRestoreEnabled: (_token: string, enabled: boolean) => {
          preferenceUpdates.push(enabled)
          markDisableStarted?.()
          return new Promise<boolean>((_resolve, reject) => {
            rejectDisable = reject
          })
        },
      },
    },
  })

  const clientState = await import("./client-state.ts")
  await clientState.initializeClientState()

  const disabling = clientState.setRestorePreviousStateEnabled(false)
  await disableStarted
  clientState.updateRestorableSession({ tabs: [{ kind: "sidecar", sidecarId: "buffered" }], activeTabIndex: 0 })
  clientState.writeClientLayoutValue("opencode-session-sidebar-width-v8", "430")
  assert.ok(rejectDisable)
  rejectDisable(new Error("native disable failed"))
  await assert.rejects(disabling, /native disable failed/)

  assert.equal(clientState.restorePreviousStateEnabled(), true)
  assert.deepEqual(preferenceUpdates, [false])
  await clientState.flushClientState()
  assert.equal(savedSnapshots.length, 1)
  assert.equal((savedSnapshots[0] as any).session.tabs[0].sidecarId, "buffered")
  assert.equal((savedSnapshots[0] as any).layout["opencode-session-sidebar-width-v8"], "430")
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
