import assert from "node:assert/strict"
import { it } from "node:test"

it("treats a rejected renderer access claim as non-primary without loading state", async () => {
  let loadCount = 0
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __CODENOMAD_RUNTIME_HOST__: "electron",
      __CODENOMAD_WINDOW_CONTEXT__: "local",
      electronAPI: {
        claimClientStateAccess: async () => {
          throw new Error("claim rejected")
        },
        loadClientState: async () => {
          loadCount += 1
          return { isPrimary: true, restoreEnabled: true, snapshot: null }
        },
      },
    },
  })

  const clientState = await import("./client-state.ts")
  await clientState.initializeClientState()

  assert.equal(clientState.clientStateIsPrimary(), false)
  assert.equal(loadCount, 0)
})
