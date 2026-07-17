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

it("keeps plain web hosts secondary and retires web snapshots without touching legacy layout", async () => {
  const storage = new MemoryStorage()
  storage.setItem("codenomad-client-snapshot-v1", JSON.stringify({
    version: 1,
    revision: 2,
    savedAt: 10,
    layout: {},
    session: { tabs: [{ kind: "sidecar", sidecarId: "private" }], activeTabIndex: 0 },
  }))
  storage.setItem("codenomad-client-restore-enabled-v1", "false")
  storage.setItem("opencode-session-sidebar-width-v8", "360")
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: storage },
  })

  const clientState = await import("./client-state.ts")
  await clientState.initializeClientState()

  assert.equal(clientState.clientStateIsPrimary(), false)
  assert.equal(clientState.loadedRestorableSession(), null)
  assert.equal(storage.getItem("codenomad-client-snapshot-v1"), null)
  assert.equal(storage.getItem("codenomad-client-restore-enabled-v1"), null)
  assert.equal(clientState.readClientLayoutValue("opencode-session-sidebar-width-v8"), "360")

  clientState.writeClientLayoutValue("opencode-session-sidebar-width-v8", "420")
  clientState.updateRestorableSession({ tabs: [{ kind: "sidecar", sidecarId: "other" }], activeTabIndex: 0 })
  await clientState.flushClientState()

  assert.equal(storage.getItem("opencode-session-sidebar-width-v8"), "420")
  assert.equal(storage.getItem("codenomad-client-snapshot-v1"), null)
  assert.equal(clientState.loadedRestorableSession(), null)
})
