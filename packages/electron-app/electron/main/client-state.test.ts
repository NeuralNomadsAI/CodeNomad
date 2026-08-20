import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { ClientStateManager, type ClientStateWriter } from "./client-state"
import { deterministicLegacyWindowId, parseClientState } from "./client-state-envelope"

test("legacy migration UUIDs are deterministic from exact envelope bytes", () => {
  const vectors = [
    ["{\"version\":1}", "2430f1a2-ad29-52d0-8678-85488a4c89e2"],
    ["{ \"version\": 1, \"restoreEnabled\": false }", "e6a1425a-ebb1-502f-b79c-d92772fa763b"],
  ] as const
  for (const [content, expected] of vectors) {
    assert.equal(deterministicLegacyWindowId(content), expected)
    assert.equal(parseClientState(content).state.activeWindowId, expected)
  }
})

test("V3 permits a temporarily empty local-window set and activates the next new record", async (t) => {
  const h = harness(t)
  const manager = h.create()
  const closed = manager.activeWindowId
  assert.equal(await manager.removeWindow(closed), true)
  assert.deepEqual(manager.windowIds, [])
  const next = "99999999-9999-4999-8999-999999999999"
  assert.equal(await manager.addWindow(next), next)
  assert.equal(manager.activeWindowId, next)
  assert.deepEqual(manager.windowIds, [next])
})

function harness(t: test.TestContext, initial?: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "codenomad-state-"))
  const statePath = join(directory, "client-state.json")
  if (initial !== undefined) writeFileSync(statePath, JSON.stringify(initial))
  let failing = false
  let writes = 0
  const managers: ClientStateManager[] = []
  const create = (writer: ClientStateWriter = async (path, value) => {
    writes++
    if (failing) throw new Error("injected write failure")
    await writeFile(path, value, "utf8")
  }, processOwner?: { pid: number; runToken: string; processStartIdentity: string }) => {
    const manager = new ClientStateManager(directory, writer, { crossHostElectionDirectory: join(directory, "election"), processOwner })
    managers.push(manager)
    return manager
  }
  t.after(async () => {
    await Promise.all(managers.map((manager) => manager.drainAndReleasePrimary().catch(() => {})))
    rmSync(directory, { recursive: true, force: true })
  })
  return { create, directory, statePath, fail: (value: boolean) => { failing = value }, writes: () => writes }
}

function persistedRecord(path: string, windowId?: string): Record<string, any> {
  const envelope = JSON.parse(readFileSync(path, "utf8"))
  return envelope.windows[windowId ?? envelope.activeWindowId]
}

test("renderer access is exclusive per document and resettable", async (t) => {
  const manager = harness(t, { version: 1, restoreEnabled: true }).create()
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

test("restore defaults on unless explicitly disabled", (t) => {
  assert.equal(harness(t).create().loadClientState().restoreEnabled, true)
  assert.equal(harness(t, { version: 1 }).create().loadClientState().restoreEnabled, true)
  assert.equal(harness(t, { version: 1, restoreEnabled: false }).create().loadClientState().restoreEnabled, false)
})

test("cross-host ownership is required in addition to each host-local election", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codenomad-cross-host-state-"))
  const electronDirectory = join(root, "electron"), tauriDirectory = join(root, "tauri"), election = join(root, "election")
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const identities = new Map([[8101, "tauri-start"], [8102, "electron-start"], [8103, "successor-start"]])
  const crossHostDependencies = { pidAlive: (pid: number) => identities.has(pid), processStartIdentity: (pid: number) => identities.get(pid) }
  const primary = new ClientStateManager(tauriDirectory, undefined, {
    crossHostElectionDirectory: election,
    crossHostDependencies,
    processOwner: { pid: 8101, runToken: "tauri", processStartIdentity: "tauri-start" },
  })
  mkdirSync(electronDirectory)
  writeFileSync(join(electronDirectory, "client-state.json"), JSON.stringify({
    version: 1,
    restoreEnabled: true,
    snapshot: { tabs: ["must-not-restore"] },
  }))
  const secondary = new ClientStateManager(electronDirectory, undefined, {
    crossHostElectionDirectory: election,
    crossHostDependencies,
    processOwner: { pid: 8102, runToken: "electron", processStartIdentity: "electron-start" },
  })
  assert.deepEqual(secondary.loadClientState(), { isPrimary: false, restoreEnabled: false, snapshot: null, partitionProtocolVersion: 1 })
  await secondary.drainAndReleasePrimary()

  await primary.drainAndReleasePrimary()
  identities.delete(8101); identities.delete(8102)
  const successor = new ClientStateManager(electronDirectory, undefined, {
    crossHostElectionDirectory: election,
    crossHostDependencies,
    processOwner: { pid: 8103, runToken: "successor", processStartIdentity: "successor-start" },
  })
  assert.equal(successor.isPrimary, true)
  await successor.drainAndReleasePrimary()
})

test("first shared primary deterministically migrates legacy host envelopes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codenomad-migration-"))
  const electron = join(root, "electron"), tauri = join(root, "tauri"), election = join(root, "shared", "election")
  mkdirSync(electron, { recursive: true }); mkdirSync(tauri, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(electron, "client-state.json"), JSON.stringify({ version: 1, restoreEnabled: true, snapshot: { revision: 999, savedAt: 10, host: "electron" } }))
  writeFileSync(join(tauri, "client-state.json"), JSON.stringify({
    version: 1,
    restoreEnabled: true,
    snapshot: { savedAt: 20, host: "tauri" },
    window: { bounds: { x: 10, y: 10, width: 1000, height: 700 }, maximized: false, fullscreen: false, zoomFactor: 1 },
  }))
  const manager = new ClientStateManager(electron, undefined, { crossHostElectionDirectory: election, legacyTauriDataPath: tauri })
  assert.deepEqual(manager.loadClientState().snapshot, { savedAt: 20, host: "tauri" })
  assert.equal(manager.getWindowState(), undefined)
  assert.equal(existsSync(join(electron, "client-state.json")), true)
  assert.equal(existsSync(join(tauri, "client-state.json")), true)
  await manager.drainAndReleasePrimary()
})

test("legacy migration prefers disabled and ignores malformed candidates", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codenomad-migration-"))
  const electron = join(root, "electron"), tauri = join(root, "tauri"), election = join(root, "shared", "election")
  mkdirSync(electron, { recursive: true }); mkdirSync(tauri, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(electron, "client-state.json"), "malformed")
  writeFileSync(join(tauri, "client-state.json"), JSON.stringify({ version: 1, restoreEnabled: false, snapshot: { savedAt: 1 } }))
  const manager = new ClientStateManager(electron, undefined, { crossHostElectionDirectory: election, legacyTauriDataPath: tauri })
  assert.deepEqual(manager.loadClientState(), { isPrimary: true, restoreEnabled: false, snapshot: null, partitionProtocolVersion: 1 })
  assert.equal(JSON.parse(readFileSync(join(root, "shared", "client-state.json"), "utf8")).restoreEnabled, false)
  await manager.drainAndReleasePrimary()
})

test("legacy migration does not resurrect a snapshot after clear", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codenomad-migration-"))
  const electron = join(root, "electron"), tauri = join(root, "tauri"), election = join(root, "shared", "election")
  mkdirSync(electron, { recursive: true }); mkdirSync(tauri, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(electron, "client-state.json"), JSON.stringify({ version: 1, restoreEnabled: true }))
  writeFileSync(join(tauri, "client-state.json"), JSON.stringify({ version: 1, restoreEnabled: true, snapshot: { savedAt: 20 } }))
  const manager = new ClientStateManager(electron, undefined, { crossHostElectionDirectory: election, legacyTauriDataPath: tauri })
  assert.equal(manager.loadClientState().snapshot, null)
  await manager.drainAndReleasePrimary()
})

test("V1 shared state is copied once and V2 mutations remain isolated", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codenomad-migration-"))
  const electron = join(root, "electron"), shared = join(root, "shared"), v2 = join(shared, "v2"), election = join(v2, "election")
  const legacyShared = join(shared, "client-state.json"), v2State = join(v2, "client-state.json")
  mkdirSync(electron, { recursive: true }); mkdirSync(shared, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const legacyBytes = '{\n  "version": 1, "restoreEnabled": true, "snapshot": { "source": "v1" }\n}'
  writeFileSync(legacyShared, legacyBytes)
  writeFileSync(join(electron, "client-state.json"), JSON.stringify({ version: 1, restoreEnabled: true, snapshot: { source: "host-local" } }))

  const manager = new ClientStateManager(electron, undefined, {
    crossHostElectionDirectory: election,
    legacySharedStatePath: legacyShared,
  })
  assert.equal(readFileSync(v2State, "utf8"), legacyBytes)
  assert.deepEqual(manager.loadClientState().snapshot, { source: "v1" })
  await manager.saveClientState({ source: "v2-save" })
  assert.equal(persistedRecord(v2State).snapshot.source, "v2-save")
  assert.equal(readFileSync(legacyShared, "utf8"), legacyBytes)
  assert.equal(await manager.setRestoreEnabled(false), true)
  assert.equal(persistedRecord(v2State).restoreEnabled, false)
  assert.equal(readFileSync(legacyShared, "utf8"), legacyBytes)
  assert.equal(await manager.clearClientState(), true)
  assert.equal(readFileSync(legacyShared, "utf8"), legacyBytes)
  assert.equal(JSON.parse(readFileSync(join(electron, "client-state.json"), "utf8")).snapshot.source, "host-local")
  await manager.drainAndReleasePrimary()

  const restarted = new ClientStateManager(electron, undefined, {
    crossHostElectionDirectory: election,
    legacySharedStatePath: legacyShared,
  })
  assert.equal(restarted.loadClientState().restoreEnabled, false)
  assert.notEqual(readFileSync(v2State, "utf8"), legacyBytes)
  assert.equal(readFileSync(legacyShared, "utf8"), legacyBytes)
  await restarted.drainAndReleasePrimary()
})

test("unshipped partitioned V2 shared state is not copied over shipped V1 migration", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codenomad-migration-"))
  const electron = join(root, "electron"), shared = join(root, "shared"), v2 = join(shared, "v2")
  mkdirSync(electron, { recursive: true }); mkdirSync(shared, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(shared, "client-state.json"), JSON.stringify({ version: 2, restoreEnabled: true }))
  writeFileSync(join(electron, "client-state.json"), JSON.stringify({ version: 1, restoreEnabled: true, snapshot: { source: "shipped-v1" } }))

  const manager = new ClientStateManager(electron, undefined, {
    crossHostElectionDirectory: join(v2, "election"),
    legacySharedStatePath: join(shared, "client-state.json"),
  })
  assert.deepEqual(manager.loadClientState().snapshot, { source: "shipped-v1" })
  assert.equal(JSON.parse(readFileSync(join(v2, "client-state.json"), "utf8")).version, 1)
  await manager.drainAndReleasePrimary()
})

test("ownership loss immediately disables restore reads and mutations", async (t) => {
  const h = harness(t, {
    version: 1,
    restoreEnabled: true,
    snapshot: { tabs: ["must-stop"] },
    window: { bounds: { x: 0, y: 0, width: 900, height: 700 }, maximized: false, fullscreen: false, zoomFactor: 1 },
  })
  const manager = h.create()
  writeFileSync(join(h.directory, "election", "primary.owner.json", "owner.json"), "malformed")
  assert.equal(manager.isPrimary, false)
  assert.deepEqual(manager.loadClientState(), { isPrimary: false, restoreEnabled: false, snapshot: null, partitionProtocolVersion: 1 })
  assert.equal(manager.getWindowState(), undefined)
  assert.equal(await manager.saveClientState({ ignored: true }), false)
})

test("failed preference and clear writes roll memory and suppression back", async (t) => {
  const h = harness(t, { version: 1, restoreEnabled: true })
  const manager = h.create()
  await manager.saveClientState({ kept: true })
  h.fail(true)
  await assert.rejects(manager.setRestoreEnabled(false), /injected write failure/)
  assert.deepEqual(manager.loadClientState(), { isPrimary: true, restoreEnabled: true, snapshot: { kept: true }, partitionProtocolVersion: 1 })
  assert.equal(persistedRecord(h.statePath).restoreEnabled, true)
  await assert.rejects(manager.clearClientState(), /injected write failure/)
  h.fail(false)
  await manager.setRestoreEnabled(true)
  const before = h.writes()
  await manager.saveClientState({ replacement: true })
  assert.equal(h.writes(), before + 1)
  assert.deepEqual(manager.loadClientState().snapshot, { replacement: true })
})

test("successful clear suppresses saves, including after failed re-enable", async (t) => {
  const h = harness(t, { version: 1, restoreEnabled: true })
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
  const h = harness(t, { version: 1, restoreEnabled: true })
  const manager = h.create(undefined, { pid: process.pid, runToken: "before-restart", processStartIdentity: "old-start" })
  await manager.saveClientState({ kept: true })
  await manager.saveWindowState({ bounds: { x: 10, y: 20, width: 1200, height: 800 }, maximized: true, fullscreen: false, zoomFactor: 1.25 })
  const before = h.writes()
  assert.equal(await manager.setRestoreEnabled(false), true)
  assert.equal(h.writes(), before + 1)
  assert.deepEqual(manager.loadClientState(), { isPrimary: true, restoreEnabled: false, snapshot: null, partitionProtocolVersion: 1 })
  assert.equal(manager.getWindowState(), undefined)
  const disabled = readFileSync(h.statePath, "utf8")
  assert.equal(persistedRecord(h.statePath).restoreEnabled, false)
  await manager.drainAndReleasePrimary()
  const restarted = h.create()
  assert.equal(await restarted.saveWindowState({ bounds: { x: 0, y: 0, width: 800, height: 600 }, maximized: false, fullscreen: false, zoomFactor: 1 }), true)
  assert.equal(readFileSync(h.statePath, "utf8"), disabled)
})

test("drain freezes mutations and waits for admitted writes", async (t) => {
  const h = harness(t, { version: 1, restoreEnabled: true })
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
  await assert.rejects(manager.addWindow(), /frozen for shutdown/)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  assert.equal(manager.isPrimary, true)
  assert.equal(existsSync(join(h.directory, "client-state.primary.lock")), true)
  assert.equal(existsSync(join(h.directory, "election", "primary.owner.json", "owner.json")), true)
  release()
  await Promise.all([admitted, drain])
  assert.equal(manager.isPrimary, false)
  assert.equal(existsSync(join(h.directory, "client-state.primary.lock")), false)
  assert.equal(existsSync(join(h.directory, "election", "primary.owner.json")), false)
  assert.deepEqual(persistedRecord(h.statePath).snapshot, { admitted: true })
})

test("a non-primary manager does not claim that a new V3 window was persisted", async (t) => {
  const h = harness(t, { version: 1, restoreEnabled: true })
  const primary = h.create()
  const secondary = h.create()
  assert.equal(secondary.isPrimary, false)
  assert.equal(await secondary.addWindow("11111111-1111-4111-8111-111111111111"), null)
  assert.equal(secondary.windowIds.length, 1)
  await Promise.all([secondary.drainAndReleasePrimary(), primary.drainAndReleasePrimary()])
})

test("an old writer cannot replace a successor after PID reuse", async (t) => {
  const h = harness(t, { version: 1, restoreEnabled: true })
  let started!: () => void
  let release!: () => void
  const began = new Promise<void>((resolve) => { started = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const old = h.create(
    async (path, value) => { await writeFile(path, value); started(); await gate },
    { pid: process.pid, runToken: "old-run", processStartIdentity: "old-start" },
  )
  const staleWrite = old.saveClientState({ stale: true })
  await began
  const oldDrain = old.drainAndReleasePrimary()
  const successor = h.create()
  assert.equal(successor.isPrimary, true)
  await successor.saveClientState({ successor: true })
  release()
  await assert.rejects(staleWrite, /ownership changed before atomic replacement/)
  await assert.rejects(oldDrain, /ownership changed before atomic replacement/)
  assert.deepEqual(persistedRecord(h.statePath).snapshot, { successor: true })
})

test("future envelopes are preserved until a successful explicit clear", async (t) => {
  const future = { version: 7, restoreEnabled: false, snapshot: { future: true }, futurePreference: "keep" }
  const h = harness(t, future)
  const manager = h.create(undefined, { pid: process.pid, runToken: "future-before-restart", processStartIdentity: "old-start" })
  assert.deepEqual(manager.loadClientState(), { isPrimary: true, restoreEnabled: false, snapshot: null, partitionProtocolVersion: 1 })
  assert.equal(await manager.saveClientState({ ignored: true }), true)
  assert.equal(await manager.setRestoreEnabled(false), false)
  assert.deepEqual(JSON.parse(readFileSync(h.statePath, "utf8")), future)
  await manager.drainAndReleasePrimary()
  const restarted = h.create()
  assert.deepEqual(JSON.parse(readFileSync(h.statePath, "utf8")), future)
  assert.equal(await restarted.clearClientState(), true)
  assert.equal(JSON.parse(readFileSync(h.statePath, "utf8")).version, 3)
  assert.equal(persistedRecord(h.statePath).restoreEnabled, false)
  assert.equal(await restarted.saveClientState({ supported: true }), true)
  assert.deepEqual(persistedRecord(h.statePath).snapshot, { supported: true })
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

const partitionKey = (content: string) => createHash("sha256").update(content).digest("hex")
const partitionRoot = (partitionKeys: string[], fields: Record<string, unknown> = {}) => ({
  ...fields,
  version: 2,
  sessionPartition: partitionKeys[0],
  partitionKeys,
})

test("envelope numeric fields follow JavaScript JSON number semantics", () => {
  const key = "a".repeat(64)
  const windowId = "11111111-1111-4111-8111-111111111111"
  const envelopes = (version: string) => version.startsWith("1")
    ? `{"version":${version},"restoreEnabled":true}`
    : version.startsWith("2")
      ? `{"version":${version},"restoreEnabled":true,"snapshot":{"version":2.0,"sessionPartition":"${key}","partitionKeys":["${key}"]},"protocolVersion":1.0,"partitionKeys":["${key}"]}`
      : `{"version":${version},"activeWindowId":"${windowId}","windowOrder":["${windowId}"],"windows":{"${windowId}":{"restoreEnabled":true}}}`
  for (const version of ["1", "1.0", "2", "2.0", "3", "3.0"]) {
    assert.equal(parseClientState(envelopes(version), windowId).unsupportedFutureEnvelope, false, version)
  }
  for (const version of ["1.5", "2.5", "3.5"]) {
    assert.equal(parseClientState(envelopes(version), windowId).unsupportedFutureEnvelope, true, version)
  }
  assert.equal(parseClientState(envelopes("2").replace("1.0", "1.5"), windowId).unsupportedFutureEnvelope, true)
  assert.equal(parseClientState(envelopes("2").replace("2.0", "2.5"), windowId).unsupportedFutureEnvelope, true)
})

test("V1 and V2 migrate in memory without load rewrites and mutate as V3", async (t) => {
  const content = "legacy partition", key = partitionKey(content)
  for (const initial of [
    { version: 1, restoreEnabled: true, snapshot: { legacy: 1 } },
    { version: 2, restoreEnabled: true, snapshot: partitionRoot([key]), protocolVersion: 1, partitionKeys: [key] },
  ]) {
    const h = harness(t, initial)
    const before = readFileSync(h.statePath, "utf8")
    const manager = h.create()
    assert.equal(readFileSync(h.statePath, "utf8"), before)
    assert.match(manager.activeWindowId, /^[0-9a-f-]{36}$/)
    await manager.saveWindowState({ bounds: { x: 1, y: 2, width: 900, height: 700 }, maximized: false, fullscreen: false, zoomFactor: 1 })
    const persisted = JSON.parse(readFileSync(h.statePath, "utf8"))
    assert.equal(persisted.version, 3)
    assert.equal(persisted.activeWindowId, manager.activeWindowId)
  }
})

test("V3 window records isolate state, tokens, partitions, clear, and removal", async (t) => {
  const h = harness(t, { version: 1, restoreEnabled: true })
  const manager = h.create()
  const windowA = manager.activeWindowId
  const windowB = "11111111-1111-4111-8111-111111111111"
  await manager.addWindow(windowB)

  manager.claimClientStateAccess("token-a", windowA)
  manager.claimClientStateAccess("token-b", windowB)
  assert.throws(() => manager.assertRendererAccessToken("token-a", windowB), /has not been claimed/)
  await manager.saveClientState({ window: "a" }, "token-a", windowA)
  await manager.saveClientState({ window: "b" }, "token-b", windowB)
  await manager.saveWindowState({ bounds: { x: 1, y: 2, width: 900, height: 700 }, maximized: false, fullscreen: false, zoomFactor: 1 }, windowA)
  await manager.saveWindowState({ bounds: { x: 3, y: 4, width: 1000, height: 800 }, maximized: true, fullscreen: false, zoomFactor: 1.25 }, windowB)
  assert.deepEqual(manager.loadClientState(windowA).snapshot, { window: "a" })
  assert.deepEqual(manager.loadClientState(windowB).snapshot, { window: "b" })
  assert.notDeepEqual(manager.getWindowState(windowA), manager.getWindowState(windowB))

  const contentA = "partition a", keyA = partitionKey(contentA)
  const contentB = "partition b", keyB = partitionKey(contentB)
  await manager.commitClientStatePartitions({ protocolVersion: 1, snapshot: partitionRoot([keyA]), partitions: { [keyA]: contentA }, partitionKeys: [keyA] }, "token-a", windowA)
  await manager.commitClientStatePartitions({ protocolVersion: 1, snapshot: partitionRoot([keyB]), partitions: { [keyB]: contentB }, partitionKeys: [keyB] }, "token-b", windowB)
  assert.equal(await manager.loadClientStatePartition(keyB, "token-a", windowA), null)
  assert.equal(await manager.loadClientStatePartition(keyB, "token-b", windowB), contentB)
  await manager.clearClientState("token-a", windowA)
  assert.equal(existsSync(join(h.directory, "partitions", keyA)), false)
  assert.equal(existsSync(join(h.directory, "partitions", keyB)), true)
  assert.equal(await manager.loadClientStatePartition(keyB, "token-b", windowB), contentB)

  assert.equal(await manager.removeWindow(windowA), true)
  const envelope = JSON.parse(readFileSync(h.statePath, "utf8"))
  assert.equal(envelope.activeWindowId, windowB)
  assert.deepEqual(envelope.windowOrder, [windowB])
  assert.deepEqual(Object.keys(envelope.windows), [windowB])
  assert.equal(existsSync(join(h.directory, "partitions", keyB)), true)
  assert.equal(await manager.removeWindow(windowB), true)
  assert.equal(existsSync(join(h.directory, "partitions", keyB)), false)
})

test("concurrent window list mutations preserve the limit and a valid active cursor", async (t) => {
  const h = harness(t, { version: 1, restoreEnabled: true })
  const manager = h.create()
  const additions = Array.from({ length: 16 }, (_, index) => manager.addWindow(`00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`))
  const results = await Promise.allSettled(additions)
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 15)
  assert.equal(results.filter(({ status }) => status === "rejected").length, 1)
  let envelope = JSON.parse(readFileSync(h.statePath, "utf8"))
  assert.equal(envelope.windowOrder.length, 16)
  assert.equal(Object.keys(envelope.windows).length, 16)

  const keep = envelope.windowOrder.slice(0, 2)
  await Promise.all(envelope.windowOrder.slice(2).map((id: string) => manager.removeWindow(id)))
  const removals = await Promise.all([manager.removeWindow(keep[0]), manager.removeWindow(keep[1])])
  assert.deepEqual(removals, [true, true])
  envelope = JSON.parse(readFileSync(h.statePath, "utf8"))
  assert.equal(envelope.windowOrder.length, 0)
  assert.deepEqual(Object.keys(envelope.windows), envelope.windowOrder)
  assert.match(envelope.activeWindowId, /^[0-9a-f-]{36}$/)
})

test("delayed focus operations serialize no-op decisions with earlier focus writes", async (t) => {
  const h = harness(t, { version: 1, restoreEnabled: true })
  let block = false
  let started!: () => void
  let release!: () => void
  const began = new Promise<void>((resolve) => { started = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const manager = h.create(async (path, value) => {
    await writeFile(path, value)
    if (block) { block = false; started(); await gate }
  })
  const original = manager.activeWindowId
  const other = "11111111-1111-4111-8111-111111111111"
  await manager.addWindow(other)

  block = true
  const delayed = manager.saveClientState({ blocked: true })
  await began
  const focusOther = manager.setActiveWindow(other)
  const focusOriginal = manager.setActiveWindow(original)
  release()
  await Promise.all([delayed, focusOther, focusOriginal])

  assert.equal(manager.activeWindowId, original)
  assert.equal(JSON.parse(readFileSync(h.statePath, "utf8")).activeWindowId, original)
})

test("queued focus rejects a window removed by an earlier queued mutation", async (t) => {
  const h = harness(t, { version: 1, restoreEnabled: true })
  let block = false
  let started!: () => void
  let release!: () => void
  const began = new Promise<void>((resolve) => { started = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const manager = h.create(async (path, value) => {
    await writeFile(path, value)
    if (block) { block = false; started(); await gate }
  })
  const removed = "22222222-2222-4222-8222-222222222222"
  await manager.addWindow(removed)

  block = true
  const delayed = manager.saveClientState({ blocked: true })
  await began
  const removal = manager.removeWindow(removed)
  const focus = manager.setActiveWindow(removed)
  release()
  await Promise.all([delayed, removal])
  await assert.rejects(focus, /Unknown client state window/)

  const envelope = JSON.parse(readFileSync(h.statePath, "utf8"))
  assert.equal(envelope.windows[removed], undefined)
  assert.equal(envelope.windowOrder.includes(envelope.activeWindowId), true)
})

test("invalid V3 remains byte-frozen until explicit clear", async (t) => {
  const windowId = "11111111-1111-4111-8111-111111111111"
  const invalid = ` { "version": 3, "activeWindowId": "${windowId}", "windowOrder": ["${windowId}"], "windows": { "${windowId}": { "restoreEnabled": true, "unknown": 1 } } } `
  const h = harness(t)
  writeFileSync(h.statePath, invalid)
  const manager = h.create()
  assert.equal(await manager.saveClientState({ ignored: true }), true)
  assert.equal(readFileSync(h.statePath, "utf8"), invalid)
  assert.equal(await manager.clearClientState(), true)
  assert.equal(JSON.parse(readFileSync(h.statePath, "utf8")).version, 3)
})

test("partition commits validate protocol and hashes", async (t) => {
  const manager = harness(t, { version: 1, restoreEnabled: true }).create()
  const content = "partition"
  const key = partitionKey(content)
  assert.throws(() => manager.commitClientStatePartitions({
    protocolVersion: 2, snapshot: partitionRoot([key]), partitions: { [key]: content }, partitionKeys: [key],
  }), /Unsupported.*protocol/)
  assert.throws(() => manager.commitClientStatePartitions({
    protocolVersion: 1, snapshot: partitionRoot([key]), partitions: { [key]: "wrong" }, partitionKeys: [key],
  }), /digest mismatch/)
  assert.throws(() => manager.commitClientStatePartitions({
    protocolVersion: 1, snapshot: partitionRoot([key]), partitions: { [key]: content }, partitionKeys: [key, key],
  }), /partition keys/)
  assert.throws(() => manager.commitClientStatePartitions({
    protocolVersion: 1, snapshot: partitionRoot([key]), partitions: {}, partitionKeys: [key],
  }), /do not match the root/)
  assert.throws(() => manager.commitClientStatePartitions({
    protocolVersion: 1, snapshot: partitionRoot([key]), partitions: { [key]: content, [partitionKey("extra")]: "extra" }, partitionKeys: [key],
  }), /do not match the root/)
  assert.throws(() => manager.commitClientStatePartitions({
    protocolVersion: 1, snapshot: partitionRoot([key]), partitions: { [key]: content }, partitionKeys: [partitionKey("other")],
  }), /do not match the commit/)

  const partitions: Record<string, string> = {}
  const partitionKeys: string[] = []
  for (let index = 0; index < 8; index++) {
    const value = `${index}${"x".repeat(1024 * 1024 - 1)}`
    const valueKey = partitionKey(value)
    partitions[valueKey] = value
    partitionKeys.push(valueKey)
  }
  partitionKeys.sort()
  assert.throws(() => manager.commitClientStatePartitions({
    protocolVersion: 1, snapshot: partitionRoot(partitionKeys), partitions, partitionKeys,
  }), /exceeds the 8 MiB limit/)
})

test("partition commit/read preserves the old root on failure and clear sweeps", async (t) => {
  const h = harness(t, { version: 1, restoreEnabled: true })
  const manager = h.create()
  const oldContent = "old partition", oldKey = partitionKey(oldContent)
  const nextContent = "next partition", nextKey = partitionKey(nextContent)
  await manager.commitClientStatePartitions({
    protocolVersion: 1, snapshot: partitionRoot([oldKey], { root: "old" }), partitions: { [oldKey]: oldContent }, partitionKeys: [oldKey],
  })
  assert.equal(await manager.loadClientStatePartition(oldKey), oldContent)
  assert.deepEqual(persistedRecord(h.statePath), {
    restoreEnabled: true, snapshot: partitionRoot([oldKey], { root: "old" }), partitionProtocolVersion: 1, partitionKeys: [oldKey],
  })

  h.fail(true)
  await assert.rejects(manager.commitClientStatePartitions({
    protocolVersion: 1, snapshot: partitionRoot([nextKey], { root: "next" }), partitions: { [nextKey]: nextContent }, partitionKeys: [nextKey],
  }), /injected write failure/)
  assert.deepEqual(manager.loadClientState().snapshot, partitionRoot([oldKey], { root: "old" }))
  assert.equal(await manager.loadClientStatePartition(oldKey), oldContent)
  assert.equal(existsSync(join(h.directory, "partitions", nextKey)), true)

  h.fail(false)
  await manager.clearClientState()
  assert.equal(existsSync(join(h.directory, "partitions", oldKey)), false)
  assert.equal(existsSync(join(h.directory, "partitions", nextKey)), false)
})

test("supported v2 window writes persist metadata and monolithic saves collect partitions", async (t) => {
  const h = harness(t, { version: 1, restoreEnabled: true })
  const manager = h.create(undefined, { pid: process.pid, runToken: "partition-window", processStartIdentity: "before-restart" })
  const content = "window partition", key = partitionKey(content)
  await manager.commitClientStatePartitions({
    protocolVersion: 1, snapshot: partitionRoot([key], { root: true }), partitions: { [key]: content }, partitionKeys: [key],
  })
  const window = { bounds: { x: 10, y: 20, width: 1000, height: 700 }, maximized: false, fullscreen: false, zoomFactor: 1.25 }
  await manager.saveWindowState(window)
  await manager.flush()
  const partitioned = JSON.parse(readFileSync(h.statePath, "utf8"))
  assert.equal(partitioned.version, 3)
  assert.equal(persistedRecord(h.statePath).partitionProtocolVersion, 1)
  assert.deepEqual(persistedRecord(h.statePath).partitionKeys, [key])
  await manager.drainAndReleasePrimary()

  const restarted = h.create()
  assert.deepEqual(restarted.getWindowState(), window)
  assert.equal(await restarted.loadClientStatePartition(key), content)
  await restarted.saveClientState({ monolithic: true })
  assert.deepEqual(persistedRecord(h.statePath), {
    restoreEnabled: true, snapshot: { monolithic: true }, window,
  })
  assert.equal(existsSync(join(h.directory, "partitions", key)), false)
})

test("malformed and future v2 roots fence writes and GC until explicit clear", async (t) => {
  const content = "keep orphan", key = partitionKey(content)
  for (const initial of [
    { version: 2, restoreEnabled: true, snapshot: {}, protocolVersion: 2, partitionKeys: [key] },
    { version: 2, restoreEnabled: true, snapshot: {}, protocolVersion: 1, partitionKeys: [key, key] },
    { version: 2, restoreEnabled: true, snapshot: {}, protocolVersion: 1, partitionKeys: [key.toUpperCase()] },
    { version: 2, restoreEnabled: true, snapshot: "x".repeat(1024 * 1024), protocolVersion: 1, partitionKeys: [key] },
    { version: 3, restoreEnabled: true, snapshot: {}, protocolVersion: 1, partitionKeys: [key] },
    { version: 2, restoreEnabled: true, snapshot: partitionRoot([key]), protocolVersion: 1, partitionKeys: [key], extra: true },
    { version: 2, restoreEnabled: true, snapshot: partitionRoot([key]), protocolVersion: 1, partitionKeys: [partitionKey("other")] },
    { version: 1, restoreEnabled: true, snapshot: {}, extra: true },
    { version: 1.5, restoreEnabled: true },
    { version: "2", restoreEnabled: true },
    "not an envelope",
  ]) {
    const h = harness(t, initial)
    const directory = join(h.directory, "partitions")
    mkdirSync(directory)
    writeFileSync(join(directory, key), content)
    const manager = h.create()
    const before = h.writes()
    assert.deepEqual(manager.loadClientState(), { isPrimary: true, restoreEnabled: false, snapshot: null, partitionProtocolVersion: 1 })
    assert.equal(await manager.loadClientStatePartition(key), null)
    assert.equal(await manager.saveClientState({ ignored: true }), true)
    assert.equal(await manager.saveWindowState({ bounds: { x: 0, y: 0, width: 800, height: 600 }, maximized: false, fullscreen: false, zoomFactor: 1 }), true)
    await manager.flush()
    assert.equal(h.writes(), before)
    assert.deepEqual(JSON.parse(readFileSync(h.statePath, "utf8")), initial)
    assert.equal(readFileSync(join(directory, key), "utf8"), content)
    assert.equal(await manager.clearClientState(), true)
    assert.equal(JSON.parse(readFileSync(h.statePath, "utf8")).version, 3)
    assert.equal(persistedRecord(h.statePath).restoreEnabled, false)
    assert.equal(existsSync(join(directory, key)), false)
  }

  const malformed = harness(t)
  writeFileSync(malformed.statePath, "{not json")
  const manager = malformed.create()
  assert.equal(await manager.saveClientState({ ignored: true }), true)
  await manager.flush()
  assert.equal(readFileSync(malformed.statePath, "utf8"), "{not json")
})

test("v1 roots with partition metadata are fenced until clear", async (t) => {
  const content = "not referenced by v1", key = partitionKey(content)
  const h = harness(t, {
    version: 1, restoreEnabled: true, snapshot: { monolithic: true }, protocolVersion: 1, partitionKeys: [key],
  })
  const directory = join(h.directory, "partitions")
  mkdirSync(directory)
  writeFileSync(join(directory, key), content)
  const manager = h.create()
  assert.deepEqual(manager.loadClientState(), { isPrimary: true, restoreEnabled: false, snapshot: null, partitionProtocolVersion: 1 })
  assert.equal(await manager.loadClientStatePartition(key), null)
  const before = readFileSync(h.statePath, "utf8")
  await manager.saveWindowState({ bounds: { x: 0, y: 0, width: 800, height: 600 }, maximized: false, fullscreen: false, zoomFactor: 1 })
  assert.equal(readFileSync(h.statePath, "utf8"), before)
})

test("partition directory and GC reject unsafe filesystem entries", async (t) => {
  const occupied = harness(t, { version: 1, restoreEnabled: true })
  writeFileSync(join(occupied.directory, "partitions"), "not a directory")
  await assert.rejects(occupied.create().commitClientStatePartitions({
    protocolVersion: 1, snapshot: partitionRoot([partitionKey("occupied")]), partitions: { [partitionKey("occupied")]: "occupied" }, partitionKeys: [partitionKey("occupied")],
  }), /partition directory|EEXIST/)

  const linked = harness(t, { version: 1, restoreEnabled: true })
  const target = join(linked.directory, "partition-target")
  mkdirSync(target)
  symlinkSync(target, join(linked.directory, "partitions"), process.platform === "win32" ? "junction" : "dir")
  await assert.rejects(linked.create().commitClientStatePartitions({
    protocolVersion: 1, snapshot: partitionRoot([partitionKey("linked")]), partitions: { [partitionKey("linked")]: "linked" }, partitionKeys: [partitionKey("linked")],
  }), /Invalid client state partition directory/)

  const gc = harness(t, { version: 1, restoreEnabled: true })
  const directory = join(gc.directory, "partitions")
  const removable = partitionKey("orphan")
  mkdirSync(directory)
  writeFileSync(join(directory, removable), "orphan")
  writeFileSync(join(directory, "unrelated.txt"), "keep")
  mkdirSync(join(directory, "f".repeat(64)))
  await gc.create().clearClientState()
  assert.equal(existsSync(join(directory, removable)), false)
  assert.equal(existsSync(join(directory, "unrelated.txt")), true)
  assert.equal(existsSync(join(directory, "f".repeat(64))), true)
})
