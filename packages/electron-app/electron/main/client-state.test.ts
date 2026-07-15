import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { ClientStateManager, type ClientStateWriter } from "./client-state"

function harness(t: test.TestContext, initial?: object) {
  const directory = mkdtempSync(join(tmpdir(), "codenomad-state-"))
  const statePath = join(directory, "client-state.json")
  if (initial) writeFileSync(statePath, JSON.stringify(initial))
  let failing = false
  let writes = 0
  const managers: ClientStateManager[] = []
  const create = (writer: ClientStateWriter = async (path, value) => {
    writes++
    if (failing) throw new Error("injected write failure")
    await writeFile(path, value, "utf8")
  }) => {
    const manager = new ClientStateManager(directory, writer)
    managers.push(manager)
    return manager
  }
  t.after(async () => {
    await Promise.all(managers.map((manager) => manager.drainAndReleasePrimary().catch(() => {})))
    rmSync(directory, { recursive: true, force: true })
  })
  return { create, directory, statePath, fail: (value: boolean) => { failing = value }, writes: () => writes }
}

test("renderer access is exclusive per document and resettable", async (t) => {
  const manager = harness(t).create()
  assert.throws(() => manager.claimClientStateAccess(""), /nonempty string/)
  assert.throws(() => manager.assertRendererAccessToken("unclaimed"), /has not been claimed/)
  assert.equal(manager.claimClientStateAccess("document-1"), true)
  assert.equal(manager.claimClientStateAccess("document-1"), true)
  assert.throws(() => manager.claimClientStateAccess("document-2"), /does not match/)
  manager.assertRendererAccessToken("document-1")
  assert.equal(await manager.saveClientState({ saved: true }), true)
  manager.resetRendererAccessToken()
  assert.throws(() => manager.assertRendererAccessToken("document-1"), /has not been claimed/)
  assert.equal(manager.claimClientStateAccess("document-2"), true)
})

test("failed preference and clear writes roll memory and suppression back", async (t) => {
  const h = harness(t)
  const manager = h.create()
  await manager.saveClientState({ kept: true })
  h.fail(true)
  await assert.rejects(manager.setRestoreEnabled(false), /injected write failure/)
  assert.deepEqual(manager.loadClientState(), { isPrimary: true, restoreEnabled: true, snapshot: { kept: true } })
  assert.equal(JSON.parse(readFileSync(h.statePath, "utf8")).restoreEnabled, true)
  await assert.rejects(manager.clearClientState(), /injected write failure/)
  h.fail(false)
  await manager.setRestoreEnabled(true)
  const before = h.writes()
  await manager.saveClientState({ replacement: true })
  assert.equal(h.writes(), before + 1)
  assert.deepEqual(manager.loadClientState().snapshot, { replacement: true })
})

test("successful clear suppresses saves, including after failed re-enable", async (t) => {
  const h = harness(t)
  const manager = h.create()
  await manager.saveClientState({ kept: true })
  await manager.clearClientState()
  h.fail(true)
  await assert.rejects(manager.setRestoreEnabled(true), /injected write failure/)
  const before = h.writes()
  assert.equal(await manager.saveClientState({ ignored: true }), true)
  assert.equal(h.writes(), before)
  assert.equal(manager.loadClientState().snapshot, null)
})

test("disabling restore atomically removes snapshot/window and survives restart", async (t) => {
  const h = harness(t)
  const manager = h.create()
  await manager.saveClientState({ kept: true })
  await manager.saveWindowState({ bounds: { x: 10, y: 20, width: 1200, height: 800 }, maximized: true, fullscreen: false, zoomFactor: 1.25 })
  const before = h.writes()
  assert.equal(await manager.setRestoreEnabled(false), true)
  assert.equal(h.writes(), before + 1)
  assert.deepEqual(manager.loadClientState(), { isPrimary: true, restoreEnabled: false, snapshot: null })
  assert.equal(manager.getWindowState(), undefined)
  const disabled = JSON.stringify({ version: 1, restoreEnabled: false })
  assert.equal(readFileSync(h.statePath, "utf8"), disabled)
  await manager.drainAndReleasePrimary()
  const restarted = h.create()
  assert.equal(await restarted.saveWindowState({ bounds: { x: 0, y: 0, width: 800, height: 600 }, maximized: false, fullscreen: false, zoomFactor: 1 }), true)
  assert.equal(readFileSync(h.statePath, "utf8"), disabled)
})

test("drain freezes mutations and waits for admitted writes", async (t) => {
  const h = harness(t)
  let started!: () => void
  let release!: () => void
  const began = new Promise<void>((resolve) => { started = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const manager = h.create(async (path, value) => { await writeFile(path, value); started(); await gate })
  const admitted = manager.saveClientState({ admitted: true })
  await began
  let settled = false
  const drain = manager.drainAndReleasePrimary().finally(() => { settled = true })
  await assert.rejects(manager.saveClientState({ late: true }), /frozen for shutdown/)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  assert.equal(manager.isPrimary, true)
  release()
  await Promise.all([admitted, drain])
  assert.equal(manager.isPrimary, false)
  assert.deepEqual(JSON.parse(readFileSync(h.statePath, "utf8")).snapshot, { admitted: true })
})

test("an old writer cannot replace a successor after PID reuse", async (t) => {
  const h = harness(t)
  let started!: () => void
  let release!: () => void
  const began = new Promise<void>((resolve) => { started = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const old = h.create(async (path, value) => { await writeFile(path, value); started(); await gate })
  const staleWrite = old.saveClientState({ stale: true })
  await began
  const oldDrain = old.drainAndReleasePrimary()
  const successor = h.create()
  assert.equal(successor.isPrimary, true)
  await successor.saveClientState({ successor: true })
  release()
  await assert.rejects(staleWrite, /ownership changed before atomic replacement/)
  await assert.rejects(oldDrain, /ownership changed before atomic replacement/)
  assert.deepEqual(JSON.parse(readFileSync(h.statePath, "utf8")).snapshot, { successor: true })
})

test("future envelopes are preserved until a successful explicit clear", async (t) => {
  const future = { version: 7, restoreEnabled: false, snapshot: { future: true }, futurePreference: "keep" }
  const h = harness(t, future)
  const manager = h.create()
  assert.deepEqual(manager.loadClientState(), { isPrimary: true, restoreEnabled: true, snapshot: null })
  assert.equal(await manager.saveClientState({ ignored: true }), true)
  assert.equal(await manager.setRestoreEnabled(false), false)
  assert.deepEqual(JSON.parse(readFileSync(h.statePath, "utf8")), future)
  await manager.drainAndReleasePrimary()
  const restarted = h.create()
  assert.deepEqual(JSON.parse(readFileSync(h.statePath, "utf8")), future)
  assert.equal(await restarted.clearClientState(), true)
  assert.deepEqual(JSON.parse(readFileSync(h.statePath, "utf8")), { version: 1, restoreEnabled: true })
  assert.equal(await restarted.saveClientState({ supported: true }), true)
  assert.deepEqual(JSON.parse(readFileSync(h.statePath, "utf8")).snapshot, { supported: true })
})

test("failed future-envelope clear leaves persistence blocked", async (t) => {
  const future = { version: 7, future: true }
  const h = harness(t, future)
  let writes = 0
  const manager = h.create(async () => { writes++; throw new Error("clear failed") })
  await assert.rejects(manager.clearClientState(), /clear failed/)
  assert.equal(await manager.setRestoreEnabled(false), false)
  assert.equal(await manager.saveClientState({ ignored: true }), true)
  assert.equal(writes, 1)
  assert.deepEqual(JSON.parse(readFileSync(h.statePath, "utf8")), future)
})
