import assert from "node:assert/strict"
import { it } from "node:test"

it("retries a one-time final-flush failure and rejects after bounded persistent failures", async () => {
  let phase: "one-time" | "persistent" = "one-time"
  let phaseAttempts = 0
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __CODENOMAD_RUNTIME_HOST__: "electron",
      __CODENOMAD_WINDOW_CONTEXT__: "local",
      electronAPI: {
        claimClientStateAccess: async () => true,
        loadClientState: async () => ({ isPrimary: true, restoreEnabled: true, snapshot: null }),
        saveClientState: async () => {
          phaseAttempts += 1
          if (phase === "persistent" || phaseAttempts === 1) throw new Error(`${phase} save failure`)
          return true
        },
      },
    },
  })

  const clientState = await import("./client-state.ts")
  await clientState.initializeClientState()

  clientState.updateRestorableSession({ tabs: [{ kind: "sidecar", sidecarId: "retry-once" }], activeTabIndex: 0 })
  await clientState.flushClientState()
  assert.equal(phaseAttempts, 2)

  phase = "persistent"
  phaseAttempts = 0
  clientState.updateRestorableSession({ tabs: [{ kind: "sidecar", sidecarId: "never-saved" }], activeTabIndex: 0 })
  await assert.rejects(clientState.flushClientState(), /persistent save failure/)
  assert.equal(phaseAttempts, 3)
})
