import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { ClientStateManager, type ClientStateWriter } from "./client-state"

function createManager(testContext: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "codenomad-client-state-manager-"))
  let failWrites = false
  let writeCount = 0
  const writer: ClientStateWriter = async (temporaryPath, serializedState) => {
    writeCount += 1
    if (failWrites) {
      throw new Error("injected write failure")
    }
    await writeFile(temporaryPath, serializedState, "utf8")
  }
  const manager = new ClientStateManager(directory, writer)
  testContext.after(async () => {
    await manager.drainAndReleasePrimary().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    directory,
    manager,
    failWrites: (fail: boolean) => {
      failWrites = fail
    },
    writeCount: () => writeCount,
  }
}

test("failed restore setting write rolls in-memory state back", async (testContext) => {
  const harness = createManager(testContext)
  await harness.manager.saveClientState({ kept: true })
  harness.failWrites(true)

  await assert.rejects(harness.manager.setRestoreEnabled(false), /injected write failure/)

  assert.deepEqual(harness.manager.loadClientState(), {
    isPrimary: true,
    restoreEnabled: true,
    snapshot: { kept: true },
  })
  const persisted = JSON.parse(readFileSync(join(harness.directory, "client-state.json"), "utf8"))
  assert.equal(persisted.restoreEnabled, true)
})

test("failed clear restores snapshot and suppression state", async (testContext) => {
  const harness = createManager(testContext)
  await harness.manager.saveClientState({ kept: true })
  harness.failWrites(true)

  await assert.rejects(harness.manager.clearClientState(), /injected write failure/)

  harness.failWrites(false)
  await harness.manager.setRestoreEnabled(true)
  assert.deepEqual(harness.manager.loadClientState().snapshot, { kept: true })

  const writesBeforeSave = harness.writeCount()
  await harness.manager.saveClientState({ replacement: true })
  assert.equal(harness.writeCount(), writesBeforeSave + 1)
  assert.deepEqual(harness.manager.loadClientState().snapshot, { replacement: true })
})

test("successful clear keeps later snapshot saves as suppressed no-ops", async (testContext) => {
  const harness = createManager(testContext)
  await harness.manager.saveClientState({ kept: true })
  await harness.manager.clearClientState()
  const writesAfterClear = harness.writeCount()

  assert.equal(await harness.manager.saveClientState({ ignored: true }), true)
  assert.equal(harness.writeCount(), writesAfterClear)
  assert.equal(harness.manager.loadClientState().snapshot, null)
})

test("failed restore re-enable keeps successful clear suppression active", async (testContext) => {
  const harness = createManager(testContext)
  await harness.manager.saveClientState({ cleared: true })
  await harness.manager.clearClientState()
  harness.failWrites(true)

  await assert.rejects(harness.manager.setRestoreEnabled(true), /injected write failure/)
  const writesAfterFailure = harness.writeCount()

  assert.equal(await harness.manager.saveClientState({ ignored: true }), true)
  assert.equal(harness.writeCount(), writesAfterFailure)
  assert.equal(harness.manager.loadClientState().snapshot, null)
})

test("disabling restore atomically removes snapshot and window state", async (testContext) => {
  const harness = createManager(testContext)
  await harness.manager.saveClientState({ kept: true })
  await harness.manager.saveWindowState({
    bounds: { x: 10, y: 20, width: 1200, height: 800 },
    maximized: true,
    fullscreen: false,
    zoomFactor: 1.25,
  })
  const writesBeforeDisable = harness.writeCount()

  assert.equal(await harness.manager.setRestoreEnabled(false), true)

  assert.equal(harness.writeCount(), writesBeforeDisable + 1)
  assert.deepEqual(harness.manager.loadClientState(), {
    isPrimary: true,
    restoreEnabled: false,
    snapshot: null,
  })
  assert.equal(harness.manager.getWindowState(), undefined)
  assert.deepEqual(JSON.parse(readFileSync(join(harness.directory, "client-state.json"), "utf8")), {
    version: 1,
    restoreEnabled: false,
  })
})

test("drain freezes new mutations and waits for every admitted write before release", async (testContext) => {
  const directory = mkdtempSync(join(tmpdir(), "codenomad-client-state-drain-"))
  let resolveWriterStarted!: () => void
  let continueWriter!: () => void
  const writerStarted = new Promise<void>((resolve) => {
    resolveWriterStarted = resolve
  })
  const writerGate = new Promise<void>((resolve) => {
    continueWriter = resolve
  })
  const writer: ClientStateWriter = async (temporaryPath, serializedState) => {
    await writeFile(temporaryPath, serializedState, "utf8")
    resolveWriterStarted()
    await writerGate
  }
  const manager = new ClientStateManager(directory, writer)
  testContext.after(async () => {
    continueWriter()
    await manager.drainAndReleasePrimary().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  })

  const admittedWrite = manager.saveClientState({ admitted: true })
  await writerStarted
  let drainSettled = false
  const drain = manager.drainAndReleasePrimary().finally(() => {
    drainSettled = true
  })

  await assert.rejects(manager.saveClientState({ tooLate: true }), /frozen for shutdown/)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(drainSettled, false)
  assert.equal(manager.isPrimary, true)

  continueWriter()
  await admittedWrite
  await drain

  assert.equal(manager.isPrimary, false)
  assert.deepEqual(JSON.parse(readFileSync(join(directory, "client-state.json"), "utf8")).snapshot, {
    admitted: true,
  })
})

test("a delayed old writer cannot replace state after a successor takes ownership", async (testContext) => {
  const directory = mkdtempSync(join(tmpdir(), "codenomad-client-state-owner-race-"))
  let resolveWriterStarted!: () => void
  let continueWriter!: () => void
  const writerStarted = new Promise<void>((resolve) => {
    resolveWriterStarted = resolve
  })
  const writerGate = new Promise<void>((resolve) => {
    continueWriter = resolve
  })
  const oldManager = new ClientStateManager(directory, async (temporaryPath, serializedState) => {
    await writeFile(temporaryPath, serializedState, "utf8")
    resolveWriterStarted()
    await writerGate
  })
  let successor: ClientStateManager | undefined
  testContext.after(async () => {
    continueWriter()
    await oldManager.drainAndReleasePrimary().catch(() => {})
    await successor?.drainAndReleasePrimary().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  })

  const staleWrite = oldManager.saveClientState({ stale: true })
  await writerStarted
  const oldDrain = oldManager.drainAndReleasePrimary()

  // A different run token with the same PID deterministically models PID reuse by a successor.
  successor = new ClientStateManager(directory)
  assert.equal(successor.isPrimary, true)
  await successor.saveClientState({ successor: true })

  continueWriter()
  await assert.rejects(staleWrite, /ownership changed before atomic replacement/)
  await assert.rejects(oldDrain, /ownership changed before atomic replacement/)
  assert.deepEqual(JSON.parse(readFileSync(join(directory, "client-state.json"), "utf8")).snapshot, {
    successor: true,
  })
})

test("future outer envelopes survive normal persistence and clear explicitly unblocks v1", async (testContext) => {
  const directory = mkdtempSync(join(tmpdir(), "codenomad-client-state-future-"))
  const statePath = join(directory, "client-state.json")
  const futureEnvelope = {
    version: 2,
    restoreEnabled: false,
    snapshot: { future: true },
    window: { futureShape: true },
    futurePreference: "preserve-me",
  }
  writeFileSync(statePath, JSON.stringify(futureEnvelope), "utf8")
  const managers: ClientStateManager[] = []
  const manager = new ClientStateManager(directory)
  managers.push(manager)
  testContext.after(async () => {
    await Promise.all(managers.map((activeManager) => activeManager.drainAndReleasePrimary().catch(() => {})))
    rmSync(directory, { recursive: true, force: true })
  })

  assert.deepEqual(manager.loadClientState(), { isPrimary: true, restoreEnabled: true, snapshot: null })
  assert.equal(await manager.saveClientState({ ignored: true }), true)
  assert.equal(await manager.setRestoreEnabled(false), false)
  assert.equal(await manager.setRestoreEnabled(true), false)
  assert.equal(
    await manager.saveWindowState({
      bounds: { x: 0, y: 0, width: 1000, height: 700 },
      maximized: false,
      fullscreen: false,
      zoomFactor: 1,
    }),
    true,
  )
  assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), futureEnvelope)

  await manager.drainAndReleasePrimary()
  const restartedManager = new ClientStateManager(directory)
  managers.push(restartedManager)
  assert.deepEqual(restartedManager.loadClientState(), { isPrimary: true, restoreEnabled: true, snapshot: null })
  assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), futureEnvelope)

  assert.equal(await restartedManager.clearClientState(), true)
  assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), { version: 1, restoreEnabled: true })
  assert.equal(await restartedManager.saveClientState({ nowSupported: true }), true)
  assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")).snapshot, { nowSupported: true })
})

test("failed future-envelope clear keeps normal persistence blocked", async (testContext) => {
  const directory = mkdtempSync(join(tmpdir(), "codenomad-client-state-future-failure-"))
  const statePath = join(directory, "client-state.json")
  const serializedFutureEnvelope = JSON.stringify({ version: 7, future: true })
  writeFileSync(statePath, serializedFutureEnvelope, "utf8")
  let writes = 0
  const manager = new ClientStateManager(directory, async () => {
    writes += 1
    throw new Error("injected future clear failure")
  })
  testContext.after(async () => {
    await manager.drainAndReleasePrimary().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  })

  await assert.rejects(manager.clearClientState(), /injected future clear failure/)
  assert.equal(await manager.setRestoreEnabled(false), false)
  assert.equal(await manager.saveClientState({ ignored: true }), true)
  assert.equal(writes, 1)
  assert.equal(readFileSync(statePath, "utf8"), serializedFutureEnvelope)
})
