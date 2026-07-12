import assert from "node:assert/strict"
import { it } from "node:test"

class MemoryStorage {
  private readonly values = new Map<string, string>()

  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, String(value)) }
}

it("claims access before loading and uses one renderer token for every native operation", async () => {
  const storage = new MemoryStorage()
  storage.setItem("opencode-session-sidebar-width-v8", "360")
  const calls: Array<{ operation: string; token: string }> = []
  const savedSnapshots: any[] = []
  let clearCount = 0
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __CODENOMAD_RUNTIME_HOST__: "electron",
      __CODENOMAD_WINDOW_CONTEXT__: "local",
      localStorage: storage,
      electronAPI: {
        claimClientStateAccess: async (token: string) => {
          calls.push({ operation: "claim", token })
          return true
        },
        loadClientState: async (token: string) => {
          calls.push({ operation: "load", token })
          return { isPrimary: true, restoreEnabled: true, snapshot: null }
        },
        saveClientState: async (token: string, snapshot: unknown) => {
          calls.push({ operation: "save", token })
          savedSnapshots.push(snapshot)
          return true
        },
        setClientStateRestoreEnabled: async (token: string, enabled: boolean) => {
          calls.push({ operation: `set:${enabled}`, token })
          return true
        },
        clearClientState: async () => {
          clearCount += 1
          return true
        },
      },
    },
  })

  const clientState = await import("./client-state.ts")
  await clientState.initializeClientState()

  assert.equal(clientState.clientStateIsPrimary(), true)
  assert.equal(clientState.readClientLayoutValue("opencode-session-sidebar-width-v8"), "360")

  clientState.writeClientLayoutValue("opencode-session-right-drawer-width-v1", "480")
  clientState.updateRestorableSession({
    activeTabIndex: 0,
    tabs: [{
      kind: "workspace",
      folder: "C:/work/project",
      drafts: { session1: "draft" },
      attachments: {},
      scrollSnapshots: {},
      unseenIdleSince: {},
      generationRecovery: {},
      sessionStatuses: {},
      expandedSessionIds: [],
    }],
  })
  await clientState.flushClientState()

  const first = savedSnapshots[0]
  assert.equal(first.version, 1)
  assert.equal(first.revision, 1)
  assert.equal(first.layout["opencode-session-sidebar-width-v8"], "360")
  assert.equal(first.session.tabs[0].folder, "C:/work/project")

  clientState.writeClientLayoutValue("opencode-session-right-drawer-width-v1", "500")
  await clientState.flushClientState()
  const second = savedSnapshots[1]
  assert.equal(second.revision, 2)

  await clientState.setRestorePreviousStateEnabled(false)
  assert.equal(clientState.restorePreviousStateEnabled(), false)
  assert.equal(clientState.loadedRestorableSession(), null)
  assert.equal(storage.getItem("opencode-session-sidebar-width-v8"), null)
  assert.equal(clientState.readClientLayoutValue("opencode-session-sidebar-width-v8"), null)
  assert.equal(clearCount, 0)
  assert.deepEqual(calls.map((call) => call.operation), ["claim", "load", "save", "save", "set:false"])
  assert.match(calls[0]!.token, /^[0-9a-f]{64}$/)
  assert.ok(calls.every((call) => call.token === calls[0]!.token))
  assert.equal(storage.getItem(calls[0]!.token), null)
})
