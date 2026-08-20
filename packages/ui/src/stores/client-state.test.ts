import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { encodeClientSnapshotV2 } from "./client-state-partitions.ts"
type ClientState = typeof import("./client-state.ts")
type NativeApi = Record<string, (...args: any[]) => any>; type TransactionKind = "clear" | "disable"
const layoutKey = "opencode-session-sidebar-width-v8"; let moduleId = 0
class MemoryStorage {
  private readonly values = new Map<string, string>()
  get length() { return this.values.size }; clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, String(value)) }
}
const session = (sidecarId: string) => ({ tabs: [{ kind: "sidecar" as const, sidecarId }], activeTabIndex: 0 })
const snapshot = (sidecarId: string, layout: Record<string, string> = {}) => ({ version: 1 as const, revision: 1, savedAt: 1, layout, session: session(sidecarId) })
const loadResult = (saved: unknown = null, isPrimary = true, partitionProtocolVersion?: 1) =>
  ({ isPrimary, restoreEnabled: true, snapshot: saved, partitionProtocolVersion })
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, reject, resolve }
}
const installWindow = (api?: NativeApi, storage = new MemoryStorage()) => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: api
    ? { __CODENOMAD_RUNTIME_HOST__: "electron", __CODENOMAD_WINDOW_CONTEXT__: "local", localStorage: storage, electronAPI: api }
    : { localStorage: storage } })
  return storage
}
const boot = async (api?: NativeApi, storage?: MemoryStorage) => {
  installWindow(api ? { claimClientStateAccess: async () => true, ...api } : undefined, storage)
  const state = await import(`./client-state.ts?test=${moduleId++}`) as ClientState
  await state.initializeClientState()
  return state
}
const transact = (state: ClientState, kind: TransactionKind) => kind === "clear"
  ? state.clearRestoredClientState() : state.setRestorePreviousStateEnabled(false)
describe("client state ownership and persistence", () => {
  it("treats a rejected access claim as secondary without loading", async () => {
    let loads = 0
    const state = await boot({
      claimClientStateAccess: async () => { throw new Error("claim rejected") },
      loadClientState: async () => { loads += 1; return loadResult() },
    })
    assert.equal(state.clientStateIsPrimary(), false)
    assert.equal(loads, 0)
  })
  it("claims before loading and reuses one renderer token for native operations", async () => {
    const storage = new MemoryStorage()
    storage.setItem(layoutKey, "360")
    const calls: Array<{ operation: string; token: string }> = [], saved: any[] = []
    const state = await boot({
      claimClientStateAccess: async (token) => { calls.push({ operation: "claim", token }); return true },
      loadClientState: async (token) => { calls.push({ operation: "load", token }); return loadResult() },
      saveClientState: async (token, value) => { calls.push({ operation: "save", token }); saved.push(value); return true },
      setClientStateRestoreEnabled: async (token, enabled) => { calls.push({ operation: `set:${enabled}`, token }); return true },
    }, storage)
    assert.equal(state.readClientLayoutValue(layoutKey), "360")
    state.updateRestorableSession(session("project")); await state.flushClientState()
    state.writeClientLayoutValue(layoutKey, "500"); await state.flushClientState()
    assert.deepEqual(saved.map(({ revision }) => revision), [1, 2])
    assert.equal(saved[0].version, 1)
    assert.equal(saved[0].layout[layoutKey], "360")
    assert.equal(saved[0].session.tabs[0].sidecarId, "project")
    await state.setRestorePreviousStateEnabled(false)
    assert.equal(state.restorePreviousStateEnabled(), false)
    assert.equal(state.loadedRestorableSession(), null)
    assert.equal(storage.getItem(layoutKey), null)
    assert.deepEqual(calls.map(({ operation }) => operation), ["claim", "load", "save", "save", "set:false"])
    assert.match(calls[0]!.token, /^[0-9a-f]{64}$/)
    assert.ok(calls.every(({ token }) => token === calls[0]!.token))
    assert.equal(storage.getItem(calls[0]!.token), null)
  })
})
const destructiveContract = async (kind: TransactionKind, inFlightSave: boolean) => {
  const operation = deferred<boolean>(), started = deferred<void>()
  const saved: any[] = [], preferences: boolean[] = []
  const api: NativeApi = {
    loadClientState: async () => loadResult(!inFlightSave && kind === "clear" ? snapshot("saved") : null),
    saveClientState: (_token, value) => {
      saved.push(value)
      if (!inFlightSave || saved.length > 1) return Promise.resolve(true)
      started.resolve(); return operation.promise
    },
  }
  api[kind === "clear" ? "clearClientState" : "setClientStateRestoreEnabled"] = (...args: any[]) => {
    if (kind === "disable") preferences.push(args[1])
    if (inFlightSave) throw new Error(`native ${kind} failed`)
    started.resolve(); return operation.promise
  }
  const state = await boot(api)
  if (inFlightSave) {
    state.updateRestorableSession(session("retry"))
    const firstFlush = state.flushClientState()
    await started.promise
    const transaction = transact(state, kind)
    operation.reject(new Error("first save failed"))
    await assert.rejects(firstFlush, /first save failed/)
    await assert.rejects(transaction, new RegExp(`native ${kind} failed`))
  } else {
    const transaction = transact(state, kind)
    await started.promise
    state.updateRestorableSession(session("buffered"))
    state.writeClientLayoutValue(layoutKey, "430")
    operation.reject(new Error(`native ${kind} failed`))
    await assert.rejects(transaction, new RegExp(`native ${kind} failed`))
  }
  assert.equal(state.restorePreviousStateEnabled(), true)
  if (kind === "disable") assert.deepEqual(preferences, [false])
  await state.flushClientState()
  assert.equal(saved.length, inFlightSave ? 2 : 1)
  assert.equal(saved.at(-1).session.tabs[0].sidecarId, inFlightSave ? "retry" : "buffered")
  if (!inFlightSave) assert.equal(saved[0].layout[layoutKey], "430")
}
describe("failed destructive transactions", () => {
  for (const kind of ["clear", "disable"] as const) {
    it(`${kind}: rolls back and persists mutations buffered during delayed failure`, () => destructiveContract(kind, false))
    it(`${kind}: preserves retry dirt from an in-flight failed save`, () => destructiveContract(kind, true))
  }
})
describe("future envelopes and clear races", () => {
  it("fences every malformed non-null snapshot", async () => {
    for (const malformed of [{ version: 2.5 }, { version: "2" }, {}, [], 7, "snapshot", true]) {
      let saves = 0
      const state = await boot({
        loadClientState: async () => loadResult(malformed),
        saveClientState: async () => { saves += 1; return true },
      })
      state.writeClientLayoutValue(layoutKey, "350")
      state.updateRestorableSession(session("overwrite"))
      await state.flushClientState()
      assert.equal(saves, 0, JSON.stringify(malformed))
    }
  })

  it("serializes overlapping clear and disable transactions without stranding writes", async () => {
    const clear = deferred<boolean>(), disable = deferred<boolean>()
    const clearStarted = deferred<void>(), disableStarted = deferred<void>()
    const operations: string[] = [], saved: any[] = []
    const state = await boot({
      loadClientState: async () => loadResult(snapshot("saved")),
      clearClientState: async () => { operations.push("clear"); clearStarted.resolve(); return clear.promise },
      setClientStateRestoreEnabled: async (_token, enabled) => {
        operations.push(`restore:${enabled}`)
        if (!enabled) disableStarted.resolve()
        return enabled ? true : disable.promise
      },
      saveClientState: async (_token, value) => { saved.push(value); return true },
    })
    const clearing = state.clearRestoredClientState()
    let sameValueSettled = false
    const sameValueEnable = state.setRestorePreviousStateEnabled(true).then(() => { sameValueSettled = true })
    const disabling = state.setRestorePreviousStateEnabled(false)
    const secondClear = state.clearRestoredClientState()
    const enabling = state.setRestorePreviousStateEnabled(true)
    await clearStarted.promise
    assert.deepEqual(operations, ["clear"], "disable waits for clear ownership")
    assert.equal(sameValueSettled, false, "same-value enable waits for prior transition")
    clear.resolve(true); await clearing; await sameValueEnable; await disableStarted.promise
    assert.deepEqual(operations, ["clear", "restore:true", "restore:false"])
    disable.resolve(true); await disabling; await secondClear; await enabling
    assert.deepEqual(operations, ["clear", "restore:true", "restore:false", "clear", "restore:true"])
    state.updateRestorableSession(session("after-overlap")); await state.flushClientState()
    assert.equal(saved.at(-1).session.tabs[0].sidecarId, "after-overlap")
  })

  it("clears a future envelope while suppressing recapture for the run", async () => {
    let clears = 0, saves = 0
    const state = await boot({
      loadClientState: async () => loadResult({ version: 3, future: true }),
      saveClientState: async () => { saves += 1; return true },
      clearClientState: async () => { clears += 1; return true },
    })
    state.writeClientLayoutValue(layoutKey, "350"); state.updateRestorableSession(session("docs"))
    await state.flushClientState(); await state.clearRestoredClientState()
    state.writeClientLayoutValue(layoutKey, "360"); state.updateRestorableSession(session("new"))
    await state.flushClientState()
    assert.equal(clears, 1)
    assert.equal(saves, 0)
  })
  it("keeps ownership of a future envelope after disable is rejected", async () => {
    let clears = 0
    const state = await boot({
      loadClientState: async () => loadResult({ version: 3, future: true }),
      setClientStateRestoreEnabled: async () => false,
      clearClientState: async () => { clears += 1; return true },
    })
    await assert.rejects(state.setRestorePreviousStateEnabled(false), /update was rejected/)
    assert.equal(state.restorePreviousStateEnabled(), true)
    assert.equal(state.clientStateIsPrimary(), true)
    await state.clearRestoredClientState()
    assert.equal(state.clientStateIsPrimary(), true)
    assert.equal(clears, 1)
  })
  it("blocks captures before an in-flight clear reaches the native host", async () => {
    const clear = deferred<boolean>(); let saves = 0
    const state = await boot({
      loadClientState: async () => loadResult(snapshot("saved")),
      saveClientState: async () => { saves += 1; return true },
      clearClientState: () => clear.promise,
    })
    const clearing = state.clearRestoredClientState()
    state.updateRestorableSession(session("transient"))
    await Promise.resolve(); clear.resolve(true); await clearing; await state.flushClientState()
    assert.equal(state.loadedRestorableSession(), null)
    assert.equal(saves, 0)
  })
})
describe("flush behavior", () => {
  it("waits for replacement writes, retries once, and bounds persistent failures", async () => {
    let phase: "race" | "one-time" | "persistent" = "race", attempts = 0
    const starts = [deferred<void>(), deferred<void>()], saves = [deferred<void>(), deferred<void>()]
    const state = await boot({
      loadClientState: async () => loadResult(),
      saveClientState: async () => {
        attempts += 1
        if (phase === "race") { starts[attempts - 1]!.resolve(); await saves[attempts - 1]!.promise; return true }
        if (phase === "persistent" || attempts === 1) throw new Error(`${phase} save failure`)
        return true
      },
    })
    state.updateRestorableSession(session("first"))
    let settled = false
    const flush = state.flushClientState().finally(() => { settled = true })
    await starts[0]!.promise; state.updateRestorableSession(session("second"))
    await new Promise((resolve) => setTimeout(resolve, 300)); saves[0]!.resolve(); await starts[1]!.promise
    await Promise.resolve(); assert.equal(settled, false, "replacement save remains part of flush")
    saves[1]!.resolve(); await flush
    for (const test of [
      { phase: "one-time" as const, attempts: 2, error: null },
      { phase: "persistent" as const, attempts: 3, error: /persistent save failure/ },
    ]) {
      phase = test.phase; attempts = 0; state.updateRestorableSession(session(test.phase))
      if (test.error) await assert.rejects(state.flushClientState(), test.error)
      else await state.flushClientState()
      assert.equal(attempts, test.attempts, test.phase)
    }
  })
})
describe("secondary hosts", () => {
  for (const host of ["electron secondary", "plain web"] as const) {
    it(`${host}: keeps layout local without restoring or writing snapshots`, async () => {
      const storage = new MemoryStorage(); storage.setItem(layoutKey, "360")
      let saves = 0
      if (host === "plain web") {
        storage.setItem("codenomad-client-snapshot-v1", JSON.stringify(snapshot("private")))
        storage.setItem("codenomad-client-restore-enabled-v1", "false")
      } else storage.removeItem(layoutKey)
      const state = await boot(host === "plain web" ? undefined : {
        loadClientState: async () => loadResult(snapshot("docs", { [layoutKey]: "380" }), false),
        saveClientState: async () => { saves += 1; return false },
      }, storage)
      assert.equal(state.clientStateIsPrimary(), false)
      assert.equal(state.loadedRestorableSession(), null)
      assert.equal(state.readClientLayoutValue(layoutKey), host === "plain web" ? "360" : null)
      state.writeClientLayoutValue(layoutKey, "420"); state.updateRestorableSession(session("other"))
      await state.flushClientState()
      assert.equal(storage.getItem(layoutKey), "420")
      assert.equal(saves, 0)
      if (host === "plain web") {
        assert.equal(storage.getItem("codenomad-client-snapshot-v1"), null)
        assert.equal(storage.getItem("codenomad-client-restore-enabled-v1"), null)
      }
    })
  }
})

describe("partitioned client state", () => {
  it("restores a degraded graph and permits a repairing write", async () => {
    const persisted = {
      version: 1 as const, revision: 3, savedAt: 4, layout: { [layoutKey]: "390" },
      session: { activeTabIndex: 0, tabs: [{
        kind: "workspace" as const, folder: "/work", activeSessionId: "active",
        drafts: { active: "keep", stale: "drop" }, attachments: {}, scrollSnapshots: {},
        unseenIdleSince: {}, generationRecovery: {},
      }] },
    }
    const encoded = await encodeClientSnapshotV2(persisted)
    const manifest = JSON.parse(encoded.partitions[encoded.root.sessionPartition]!)
    const workspace = JSON.parse(encoded.partitions[manifest.session.tabs[0].workspacePartition]!)
    const staleDocument = workspace.sessions.stale.documentPartition
    const commits: any[] = []
    const state = await boot({
      loadClientState: async () => loadResult(encoded.root, true, 1),
      loadClientStatePartition: async (_token, key) => key === staleDocument ? null : encoded.partitions[key] ?? null,
      commitClientStatePartitions: async (_token, value) => { commits.push(value); return true },
    })

    const restored = state.loadedRestorableSession()?.tabs[0]
    assert.equal(restored?.kind === "workspace" ? restored.drafts.active : undefined, "keep")
    assert.equal(restored?.kind === "workspace" ? restored.drafts.stale : undefined, undefined)
    assert.equal(state.readClientLayoutValue(layoutKey), "390")
    state.updateRestorableSession(session("repaired"))
    await state.flushClientState()
    assert.equal(commits.length, 1)
  })

  it("commits one atomic graph without a monolithic save or automatic load rewrite", async () => {
    const encoded = await encodeClientSnapshotV2(snapshot("restored", { [layoutKey]: "380" }))
    const commits: any[] = []; let monolithicSaves = 0
    const state = await boot({
      loadClientState: async () => loadResult(encoded.root, true, 1),
      loadClientStatePartition: async (_token, key) => encoded.partitions[key] ?? null,
      commitClientStatePartitions: async (_token, value) => { commits.push(value); return true },
      saveClientState: async () => { monolithicSaves += 1; return true },
    })
    assert.equal(state.loadedRestorableSession()?.tabs[0]?.kind, "sidecar")
    assert.equal(state.readClientLayoutValue(layoutKey), "380")
    assert.equal(commits.length, 0, "load does not automatically rewrite the graph")
    assert.equal(monolithicSaves, 0)

    state.updateRestorableSession(session("next")); await state.flushClientState()
    assert.equal(monolithicSaves, 0)
    assert.equal(commits.length, 1)
    assert.equal(commits[0].snapshot.version, 2)
    assert.equal(Object.prototype.hasOwnProperty.call(commits[0].snapshot, "session"), false)
    assert.deepEqual(commits[0].partitionKeys, [...commits[0].partitionKeys].sort())
    assert.deepEqual(commits[0].snapshot.partitionKeys, commits[0].partitionKeys)
    assert.deepEqual(Object.keys(commits[0].partitions), commits[0].partitionKeys)
    const manifest = JSON.parse(commits[0].partitions[commits[0].snapshot.sessionPartition])
    assert.equal(manifest.format, 2)
    assert.equal(manifest.session.tabs[0].sidecarId, "next")
  })

  it("uses the V1 monolithic save when partition capability is absent", async () => {
    const saved: any[] = []; let commits = 0
    const state = await boot({
      loadClientState: async () => loadResult(snapshot("old")),
      saveClientState: async (_token, value) => { saved.push(value); return true },
      commitClientStatePartitions: async () => { commits += 1; return true },
    })
    await state.flushClientState()
    assert.equal(saved.length, 0, "loading V1 alone does not rewrite it")
    state.updateRestorableSession(session("fallback")); await state.flushClientState()
    assert.equal(commits, 0)
    assert.equal(saved[0].version, 1)
    assert.equal(saved[0].session.tabs[0].sidecarId, "fallback")
  })

  it("keeps an oversized V1 draft attachment dirty instead of truncating or overwriting it", async () => {
    let nativeSaves = 0
    const state = await boot({
      loadClientState: async () => loadResult(null),
      saveClientState: async () => { nativeSaves += 1; return true },
    })
    const data = Buffer.alloc(1024 * 1024, 7).toString("base64")
    state.updateRestorableSession({ tabs: [{
      kind: "workspace", folder: "/work", activeSessionId: "active",
      drafts: { active: "Review [Image #1]" },
      attachments: { active: [{
        id: "large", type: "file", display: "[Image #1]", url: "", filename: "large.bin",
        mediaType: "application/octet-stream",
        source: { type: "file", path: "large.bin", mime: "application/octet-stream", data },
      }] },
      scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {},
    }], activeTabIndex: 0 })

    await assert.rejects(state.flushClientState(), /V1 1 MiB limit/)
    await assert.rejects(state.flushClientState(), /V1 1 MiB limit/)
    const restored = state.loadedRestorableSession()?.tabs[0]
    const source = restored?.kind === "workspace" ? restored.attachments.active?.[0]?.source : undefined
    assert.equal(nativeSaves, 0)
    assert.equal(restored?.kind === "workspace" ? restored.drafts.active : undefined, "Review [Image #1]")
    assert.equal(source?.type === "file" ? source.data : undefined, data)
  })

  it("migrates a loaded V1 snapshot on the next real partition-capable save", async () => {
    const commits: any[] = []; let saves = 0
    const state = await boot({
      loadClientState: async () => loadResult(snapshot("old"), true, 1),
      loadClientStatePartition: async () => null,
      commitClientStatePartitions: async (_token, value) => { commits.push(value); return true },
      saveClientState: async () => { saves += 1; return true },
    })
    await state.flushClientState()
    assert.equal(commits.length, 0, "load does not automatically migrate")
    state.updateRestorableSession(session("migrated")); await state.flushClientState()
    assert.equal(saves, 0)
    assert.equal(commits.length, 1)
    assert.equal(commits[0].snapshot.version, 2)
    const manifest = JSON.parse(commits[0].partitions[commits[0].snapshot.sessionPartition])
    assert.equal(manifest.session.tabs[0].sidecarId, "migrated")
  })

  for (const missing of ["commitClientStatePartitions", "loadClientStatePartition"] as const) {
    it(`falls back to V1 when Electron advertises a stale capability without ${missing}`, async () => {
      const saved: any[] = []
      const api: NativeApi = {
        loadClientState: async () => loadResult(snapshot("old"), true, 1),
        saveClientState: async (_token, value) => { saved.push(value); return true },
        commitClientStatePartitions: async () => true,
        loadClientStatePartition: async () => null,
      }
      delete api[missing]
      const state = await boot(api)
      state.updateRestorableSession(session("fallback")); await state.flushClientState()
      assert.equal(saved.length, 1)
      assert.equal(saved[0].version, 1)
    })
  }

  it("keeps a V2 root fenced when Electron advertises a stale partial capability", async () => {
    const encoded = await encodeClientSnapshotV2(snapshot("stored")); let writes = 0
    const state = await boot({
      loadClientState: async () => loadResult(encoded.root, true, 1),
      loadClientStatePartition: async (_token, key) => encoded.partitions[key] ?? null,
      saveClientState: async () => { writes += 1; return true },
    })
    state.updateRestorableSession(session("overwrite")); await state.flushClientState()
    assert.equal(state.loadedRestorableSession(), null)
    assert.equal(writes, 0)
  })

  it("retries a rejected partition commit promise", async () => {
    let attempts = 0
    const state = await boot({
      loadClientState: async () => loadResult(null, true, 1),
      loadClientStatePartition: async () => null,
      commitClientStatePartitions: async () => {
        attempts += 1
        if (attempts === 1) throw new Error("transient partition failure")
        return true
      },
    })
    state.updateRestorableSession(session("retry")); await state.flushClientState()
    assert.equal(attempts, 2)
  })

  for (const kind of ["malformed root", "missing partition", "hash mismatch"] as const) {
    it(`fences writes for a ${kind}`, async () => {
      const encoded = await encodeClientSnapshotV2(snapshot("stored"))
      let writes = 0
      const state = await boot({
        loadClientState: async () => loadResult(kind === "malformed root"
          ? { ...encoded.root, sessionPartition: "bad" } : encoded.root, true, 1),
        loadClientStatePartition: async () => kind === "missing partition" ? null : "wrong partition",
        commitClientStatePartitions: async () => { writes += 1; return true },
      })
      state.updateRestorableSession(session("overwrite")); await state.flushClientState()
      assert.equal(state.loadedRestorableSession(), null)
      assert.equal(writes, 0)
    })
  }

  for (const kind of ["clear", "disable"] as const) {
    it(`keeps ${kind} available while malformed V2 state is fenced`, async () => {
      let escapes = 0
      const state = await boot({
        loadClientState: async () => loadResult({ version: 2 }, true, 1),
        clearClientState: async () => { escapes += 1; return true },
        setClientStateRestoreEnabled: async () => { escapes += 1; return true },
      })
      await (kind === "clear" ? state.clearRestoredClientState() : state.setRestorePreviousStateEnabled(false))
      assert.equal(escapes, 1)
    })
  }
})
