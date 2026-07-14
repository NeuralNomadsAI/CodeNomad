import assert from "node:assert/strict"
import { it } from "node:test"

it("waits for replacement writes, retries once, and bounds persistent flush failures", async () => {
  let phase: "race" | "one-time" | "persistent" = "race"
  let phaseAttempts = 0
  let releaseFirstRaceSave!: () => void
  let releaseSecondRaceSave!: () => void
  let markFirstRaceSaveStarted!: () => void
  let markSecondRaceSaveStarted!: () => void
  const firstRaceSaveStarted = new Promise<void>((resolve) => { markFirstRaceSaveStarted = resolve })
  const secondRaceSaveStarted = new Promise<void>((resolve) => { markSecondRaceSaveStarted = resolve })
  const firstRaceSave = new Promise<void>((resolve) => { releaseFirstRaceSave = resolve })
  const secondRaceSave = new Promise<void>((resolve) => { releaseSecondRaceSave = resolve })
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
          if (phase === "race") {
            if (phaseAttempts === 1) {
              markFirstRaceSaveStarted()
              await firstRaceSave
            } else {
              markSecondRaceSaveStarted()
              await secondRaceSave
            }
            return true
          }
          if (phase === "persistent" || phaseAttempts === 1) throw new Error(`${phase} save failure`)
          return true
        },
      },
    },
  })

  const clientState = await import("./client-state.ts")
  await clientState.initializeClientState()

  clientState.updateRestorableSession({ tabs: [{ kind: "sidecar", sidecarId: "first" }], activeTabIndex: 0 })
  let racingFlushSettled = false
  const racingFlush = clientState.flushClientState().finally(() => { racingFlushSettled = true })
  await firstRaceSaveStarted
  clientState.updateRestorableSession({ tabs: [{ kind: "sidecar", sidecarId: "second" }], activeTabIndex: 0 })
  await new Promise((resolve) => setTimeout(resolve, 300))
  releaseFirstRaceSave()
  await secondRaceSaveStarted
  await Promise.resolve()
  assert.equal(racingFlushSettled, false)
  releaseSecondRaceSave()
  await racingFlush

  phase = "one-time"
  phaseAttempts = 0
  clientState.updateRestorableSession({ tabs: [{ kind: "sidecar", sidecarId: "retry-once" }], activeTabIndex: 0 })
  await clientState.flushClientState()
  assert.equal(phaseAttempts, 2)

  phase = "persistent"
  phaseAttempts = 0
  clientState.updateRestorableSession({ tabs: [{ kind: "sidecar", sidecarId: "never-saved" }], activeTabIndex: 0 })
  await assert.rejects(clientState.flushClientState(), /persistent save failure/)
  assert.equal(phaseAttempts, 3)
})
