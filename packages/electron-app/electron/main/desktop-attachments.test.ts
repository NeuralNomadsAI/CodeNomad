import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { ClientStateManager, type ClientStateWriter } from "./client-state"
import { ClientStatePartitionStore } from "./client-state-partitions"
import { LocalWindowRegistry } from "./local-window-registry"
import { DesktopAttachments } from "./desktop-attachments"
import { retainedProjectMetadata } from "./client-state-attachment-metadata"
import { encodeClientSnapshotV2 } from "../../../ui/src/stores/client-state-partitions"
import vector from "./client-state-attachment-vector.json"
import { NativeParent } from "../../../server/src/native-parent"
import { dispatchNativeRequest, parseNativeRequest } from "./native-request"

function harness(t: test.TestContext, initial?: unknown, writer?: ClientStateWriter, partitions?: Record<string, string>) {
  const directory = mkdtempSync(join(process.cwd(), ".tmp-attachments-"))
  if (initial !== undefined) writeFileSync(join(directory, "client-state.json"), typeof initial === "string" ? initial : JSON.stringify(initial))
  if (partitions) {
    mkdirSync(join(directory, "partitions"))
    for (const [key, text] of Object.entries(partitions)) writeFileSync(join(directory, "partitions", key), text)
  }
  const state = new ClientStateManager(directory, writer, { crossHostElectionDirectory: join(directory, "election") })
  const windows = new LocalWindowRegistry(() => {})
  const owner = new DesktopAttachments(state, windows)
  t.after(async () => { await state.drainAndReleasePrimary().catch(() => {}); rmSync(directory, { recursive: true, force: true }) })
  const add = (id = state.activeWindowId, persisted = true, connectOnly = false) => windows.add({ id, persisted, connectOnly,
    window: { webContents: { id: Math.random(), isDestroyed: () => false }, isDestroyed: () => false } as never,
    navigation: {} as never, tracker: null, loading: true, backendUrl: null, pendingFolders: [] })
  return { state, windows, owner, add, directory }
}

const tab = (serverId = "orphan", folder = "Z:\\Case\\Opaque/ ") => ({ kind: "workspace" as const, serverId, folder,
  drafts: { secret: "DRAFT_SENTINEL" } as Record<string, string>, attachments: {}, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {} })
const snapshot = (tabs = [tab()]) => ({ version: 1 as const, revision: 1, savedAt: 1, layout: {}, session: { tabs, activeTabIndex: 0 } })

test("both hosts' shared fixture comes from the real renderer encoder", async () => {
  const source = snapshot([{ ...tab("unknown-A", "Z:\\Case\\Project/ "), drafts: {} }])
  assert.deepEqual(await encodeClientSnapshotV2(source), vector)
})

test("real V1/V2/V3 owners retain exact shells; private inventory unions retained and ephemeral live windows with unknown coverage", async t => {
  for (const version of [1, 2, 3]) {
    const encoded = await encodeClientSnapshotV2(snapshot())
    const h = version === 2
      ? harness(t, { version: 2, restoreEnabled: true, protocolVersion: 1, snapshot: encoded.root, partitionKeys: encoded.partitionKeys }, undefined, encoded.partitions)
      : harness(t, version === 1 ? { version: 1, restoreEnabled: true, snapshot: snapshot() } : undefined)
    if (version === 3) {
      await h.state.commitClientStatePartitions({ protocolVersion: 1, snapshot: encoded.root, partitions: encoded.partitions, partitionKeys: encoded.partitionKeys })
    }
    if (version !== 1) {
      const loads: string[] = [], original = ClientStatePartitionStore.prototype.load
      const spy = t.mock.method(ClientStatePartitionStore.prototype, "load", function(this: ClientStatePartitionStore, key: string, valid: () => void) { loads.push(key); return original.call(this, key, valid) })
      const result = await h.owner.read()
      assert.deepEqual(loads, [encoded.root.sessionPartition])
      spy.mock.restore()
      assert.equal(result.refs[0]!.serverId, "orphan")
    }
    h.add()
    h.add(randomUUID(), false)
    const result = await h.owner.read()
    assert.equal(result.status, "unknown")
    assert.equal(result.retainedStatus, "complete")
    assert.equal(result.owners.length, 2)
    assert.equal(result.owners.filter(owner => owner.live && owner.retained).length, 1)
    assert.equal(result.refs.length, 1)
    assert.equal(result.refs[0]!.directory, tab().folder)
    assert.equal(h.owner.current(result.receipt), true)
    assert.doesNotMatch(JSON.stringify(result), /DRAFT_SENTINEL|workspacePartition|sessionPartition|rendererAccessToken/)
    h.windows.remove(h.state.activeWindowId)
    assert.equal(h.owner.current(result.receipt), false)
    h.add()
    assert.equal(h.owner.current(result.receipt), false)
  }
})

test("real partition verification, overflow, corrupt/future state and secondary ownership never become empty-complete", async t => {
  for (const initial of ["{", { version: 99 }, { version: 3, windows: {}, windowOrder: [] }]) {
    const h = harness(t, initial)
    assert.equal((await h.owner.read()).retainedStatus, "unknown")
  }
  const h = harness(t)
  const encoded = await encodeClientSnapshotV2(snapshot())
  await h.state.commitClientStatePartitions({ protocolVersion: 1, snapshot: encoded.root, partitions: encoded.partitions, partitionKeys: encoded.partitionKeys })
  writeFileSync(join(h.directory, "partitions", encoded.root.sessionPartition), "corrupt")
  assert.equal((await h.owner.read()).retainedStatus, "unknown")
  rmSync(join(h.directory, "partitions", encoded.root.sessionPartition))
  assert.equal((await h.owner.read()).retainedStatus, "unknown")
  await h.state.saveClientState(snapshot(Array.from({ length: 33 }, () => tab())))
  assert.equal((await h.owner.read()).retainedStatus, "unknown")
  await h.state.setRestoreEnabled(false)
  const disabled = await h.owner.read()
  assert.equal(disabled.status, "unknown")
  assert.deepEqual(disabled.refs, [])
  const secondary = new ClientStateManager(h.directory, undefined, { crossHostElectionDirectory: join(h.directory, "election") })
  t.after(() => secondary.drainAndReleasePrimary())
  assert.equal((await secondary.retainedAttachments()).status, "unknown")
})

test("receipt retirement spans queued publication, rollback, navigation, remove/reuse and shutdown", async t => {
  let fail = false, release!: () => void, entered!: () => void
  let hold = false
  const arrived = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const h = harness(t, { version: 1, restoreEnabled: true, snapshot: snapshot() }, async (path, text) => {
    if (hold) { entered(); await gate }
    if (fail) throw new Error("owned write failure")
    await writeFile(path, text)
  })
  const first = await h.owner.read()
  hold = true; fail = true
  const pending = h.state.saveClientState(snapshot([tab("A", "/new")]))
  const rejected = assert.rejects(pending, /owned write failure/)
  await arrived
  assert.equal(h.owner.current(first.receipt), false)
  let settled = false
  const reading = h.owner.read().then(value => { settled = true; return value })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  release(); await rejected
  assert.equal((await reading).retainedStatus, "unknown")
  hold = false; fail = false
  await h.state.saveClientState(snapshot())
  const stable = await h.owner.read()
  assert.equal(stable.refs[0]!.serverId, "orphan")
  h.state.resetRendererAccessToken()
  assert.equal(h.owner.current(stable.receipt), false)
  const again = await h.owner.read()
  const id = h.state.activeWindowId
  await h.state.removeWindow(id); await h.state.addWindow(id as ReturnType<typeof randomUUID>)
  assert.equal(h.owner.current(again.receipt), false)
  const last = await h.owner.read()
  await h.state.drainAndReleasePrimary()
  assert.equal(h.owner.current(last.receipt), false)
  assert.doesNotMatch(readFileSync(join(h.directory, "client-state.json"), "utf8"), /receipt|ownerId|tabId|DRAFT_SENTINEL/)
})

test("metadata projection ignores draft getters and refuses malformed shell identities without following content", async () => {
  const shell = tab()
  Object.defineProperty(shell, "drafts", { get() { throw new Error("draft read forbidden") } })
  const read = () => { throw new Error("partition read forbidden") }
  const result = await retainedProjectMetadata({ restoreEnabled: true, snapshot: snapshot([shell]) }, read)
  assert.equal(result![0]!.directory, shell.folder)
  for (const malformed of [{ ...tab(), serverId: "../bad" }, { ...tab(), folder: "x\0y" }, { ...tab(), occurrence: 32 }, { kind: "unknown" }]) {
    assert.equal(await retainedProjectMetadata({ restoreEnabled: true, snapshot: { version: 1, session: { tabs: [malformed], activeTabIndex: 0 } } }, read), undefined)
  }
})

test("real private parent and child dispatch carry only metadata and fence a retired backend", async t => {
  const h = harness(t, { version: 1, restoreEnabled: true, snapshot: snapshot() })
  let current = true
  let dispatched: Promise<void> | undefined
  const parent = new NativeParent({ write(line) {
    const request = parseNativeRequest(String(line))!
    const child = { stdin: { writable: true, write(response: string) { parent.handleLine(response); return true } } }
    dispatched = dispatchNativeRequest(child as never, request, (method, params) => h.owner.handle(method, params), () => current)
    return true
  } }, true)
  t.after(() => parent.close())
  const result = await parent.request<{ receipt: string; status: string; refs: unknown[] }>("projects.attachments.read", {})
  await dispatched
  assert.equal(result.status, "unknown")
  assert.equal(result.refs.length, 1)
  assert.equal(await parent.request("projects.attachments.current", { receipt: result.receipt }), true)
  await dispatched
  await assert.rejects(parent.request("projects.attachments.generic", { path: "forbidden" }), /attachment_inventory_unavailable/)
  await dispatched
  current = false
  const stale = parent.request("projects.attachments.read", {})
  const rejected = assert.rejects(stale, /shutting down/)
  await dispatched
  parent.close()
  await rejected
})

test("native receipts belong to the actual backend child object, including zero-project replacement", async t => {
  const h = harness(t, { version: 1, restoreEnabled: true, snapshot: { version: 1, session: null } })
  const firstBackend = {}, secondBackend = {}
  const first = await h.owner.handle("projects.attachments.read", {}, firstBackend) as { receipt: string; status: string }
  assert.equal(await h.owner.handle("projects.attachments.current", { receipt: first.receipt }, firstBackend), true)
  assert.equal(await h.owner.handle("projects.attachments.current", { receipt: first.receipt }, secondBackend), false)
  const fresh = await h.owner.handle("projects.attachments.read", {}, secondBackend) as { receipt: string; status: string }
  assert.equal(fresh.status, "unknown")
  assert.equal(await h.owner.handle("projects.attachments.current", { receipt: fresh.receipt }, secondBackend), true)
  assert.notEqual(first.receipt, fresh.receipt)
})

test("hidden launch windows retire attachment receipts without taking the user window's MRU", async t => {
  const h = harness(t)
  h.add()
  const previous = await h.owner.read()
  const hidden = randomUUID()
  h.add(hidden, false, true)
  assert.equal(h.owner.current(previous.receipt), false)
  assert.equal(h.windows.mruRecord()?.id, h.state.activeWindowId)
  const current = await h.owner.read()
  assert.equal(current.owners.length, 2)
  h.windows.remove(hidden)
  assert.equal(h.owner.current(current.receipt), false)
})
