import assert from "node:assert/strict"
import { it } from "node:test"

it("clears a native future envelope while suppressing recapture for the rest of the run", async () => {
  let clearCount = 0
  let saveCount = 0
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __CODENOMAD_RUNTIME_HOST__: "electron",
      __CODENOMAD_WINDOW_CONTEXT__: "local",
      electronAPI: {
        claimClientStateAccess: async () => true,
        loadClientState: async () => ({
          isPrimary: true,
          restoreEnabled: true,
          snapshot: { version: 2, future: true },
        }),
        saveClientState: async () => {
          saveCount += 1
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
  clientState.writeClientLayoutValue("opencode-session-sidebar-width-v8", "350")
  clientState.updateRestorableSession({ tabs: [{ kind: "sidecar", sidecarId: "docs" }], activeTabIndex: 0 })
  await clientState.flushClientState()
  assert.equal(saveCount, 0)

  await clientState.clearRestoredClientState()
  clientState.writeClientLayoutValue("opencode-session-sidebar-width-v8", "360")
  clientState.updateRestorableSession({ tabs: [{ kind: "sidecar", sidecarId: "new" }], activeTabIndex: 0 })
  await clientState.flushClientState()
  assert.equal(clearCount, 1)
  assert.equal(saveCount, 0)
})
