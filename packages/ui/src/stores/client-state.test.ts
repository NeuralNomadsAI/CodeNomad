import assert from "node:assert/strict"
import { describe, it } from "node:test"
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
const snapshot = (sidecarId: string, layout: Record<string, string> = {}) => ({ version: 1, revision: 1, savedAt: 1, layout, session: session(sidecarId) })
const loadResult = (saved: unknown = null, isPrimary = true) => ({ isPrimary, restoreEnabled: true, snapshot: saved })
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
      loadClientState: async () => loadResult({ version: 2, future: true }),
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
      loadClientState: async () => loadResult({ version: 2, future: true }),
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
  it("re-queries native state after a late ownership transition", async () => {
    let primary = false, saves = 0
    const state = await boot({
      loadClientState: async () => loadResult(null, primary),
      saveClientState: async () => { saves += 1; return true },
    })
    assert.equal(state.clientStateIsPrimary(), false)

    primary = true
    await state.refreshClientStateOwnership()
    assert.equal(state.clientStateIsPrimary(), true)
    state.updateRestorableSession(session("promoted"))
    await state.flushClientState()
    assert.equal(saves, 1)
  })
  it("reloads on native promotion before capture and resumes from the authoritative revision", async () => {
    let primary = false, ownershipChanged!: () => void, reloads = 0
    const saved: any[] = []
    const authoritative = { ...snapshot("authoritative", { [layoutKey]: "480" }), revision: 7 }
    const api = {
      onClientStateOwnershipChange: (callback: () => void) => { ownershipChanged = callback; return () => {} },
      loadClientState: async () => loadResult(authoritative, primary),
      saveClientState: async (_token: string, value: unknown) => { saved.push(value); return true },
    }
    const secondary = await boot(api)
    Object.defineProperty(window, "location", { configurable: true, value: { reload: () => { reloads += 1 } } })
    primary = true
    ownershipChanged()
    assert.equal(reloads, 1)
    assert.equal(secondary.clientStateIsPrimary(), false)
    assert.equal(saved.length, 0)

    const promoted = await boot(api)
    assert.deepEqual(promoted.loadedRestorableSession()?.tabs[0], { kind: "sidecar", sidecarId: "authoritative" })
    promoted.updateRestorableSession(session("after-promotion"))
    await promoted.flushClientState()
    assert.equal(saved[0].revision, 8)
    assert.equal(saved[0].layout[layoutKey], "480")
  })
  it("retries a load overlapped by promotion during initialization", async () => {
    const firstLoad = deferred<ReturnType<typeof loadResult>>()
    let ownershipChanged!: () => void, loads = 0
    const authoritative = { ...snapshot("authoritative"), revision: 9 }
    installWindow({
      claimClientStateAccess: async () => true,
      onClientStateOwnershipChange: (callback: () => void) => { ownershipChanged = callback; return () => {} },
      loadClientState: async () => {
        loads += 1
        return loads === 1 ? firstLoad.promise : loadResult(authoritative, true)
      },
    })
    const state = await import(`./client-state.ts?test=${moduleId++}`) as ClientState
    const initializing = state.initializeClientState()
    await Promise.resolve()
    ownershipChanged()
    firstLoad.resolve(loadResult(null, false))
    await initializing

    assert.equal(loads, 2)
    assert.equal(state.clientStateIsPrimary(), true)
    assert.deepEqual(state.loadedRestorableSession()?.tabs[0], { kind: "sidecar", sidecarId: "authoritative" })
  })
})
