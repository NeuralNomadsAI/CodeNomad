import assert from "node:assert/strict"
import { it } from "node:test"

it("keeps primary ownership so a future envelope can be cleared after disable is rejected", async () => {
  let disableCount = 0
  let clearCount = 0
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
        setClientStateRestoreEnabled: async () => {
          disableCount += 1
          return false
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
  await assert.rejects(clientState.setRestorePreviousStateEnabled(false), /update was rejected/)

  assert.equal(clientState.restorePreviousStateEnabled(), true)
  assert.equal(clientState.clientStateIsPrimary(), true)
  assert.equal(disableCount, 1)
  await clientState.clearRestoredClientState()
  assert.equal(clientState.clientStateIsPrimary(), true)
  assert.equal(clearCount, 1)
})
