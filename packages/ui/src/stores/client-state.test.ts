import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { setImmediate } from "node:timers/promises"
import { encodeClientSnapshotV2 } from "./client-state-partitions.ts"
import { normalizePersistedOutline } from "./session-outline-persistence.ts"
import { compactMissionKey } from "./tab-view-state-migration.ts"
import { normalizeRestorableSession } from "./client-state-codec.ts"
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
  it("keeps the draft's observed version across restore toggles and rejects close without blocking an unrelated snapshot", async () => {
    const key = "checkout/file", fingerprint = "0".repeat(64)
    const first = { fingerprint, text: "version observed by this renderer" }
    const newer = { fingerprint, text: "version kept by another window" }
    let stored: typeof first | null = first
    let lastSnapshot: any
    const results: boolean[] = []
    const state = await boot({
      loadClientState: async () => loadResult(),
      setClientStateRestoreEnabled: async () => true,
      saveClientState: async (_token, value) => { lastSnapshot = value; return true },
      loadFileDrafts: async () => stored ? [{ key, ...stored }] : [],
      saveFileDraft: async (_token, change) => {
        assert.equal(change.key, key)
        if (change.expected?.text !== stored?.text) return change.draft === null
        stored = change.draft
        return true
      },
    })

    assert.deepEqual(await state.refreshWorkspaceFileDraft(key), { key, ...first })
    await state.setRestorePreviousStateEnabled(false)
    assert.equal(state.updateWorkspaceFileDraft(key, { ...first, text: "my latest edit" }, ok => results.push(ok)), true)
    stored = newer
    await state.setRestorePreviousStateEnabled(true)
    assert.deepEqual(results, [false])
    state.updateRestorableSession(session("snapshot survives"))
    await state.flushClientState()
    assert.deepEqual(lastSnapshot.session, session("snapshot survives"))
    await assert.rejects(state.flushWorkspaceFileDraftsForClose(), state.WorkspaceDraftFlushError)
    assert.deepEqual(stored, newer)

    // Saving/discarding this reader releases the close hold without removing the other draft.
    assert.equal(state.updateWorkspaceFileDraft(key, null, ok => results.push(ok)), true)
    await state.flushWorkspaceFileDraftsForClose()
    assert.deepEqual(results, [false, true])
    assert.deepEqual(stored, newer)
    assert.deepEqual(await state.refreshWorkspaceFileDraft(key), { key, ...newer })
  })
  it("an older write acknowledgment cannot clear the close hold for a larger new edit", async () => {
    const key = "checkout/file", fingerprint = "0".repeat(64)
    const started = deferred<void>()
    const release = deferred<boolean>()
    const state = await boot({
      loadClientState: async () => loadResult(),
      saveFileDraft: async () => { started.resolve(); return release.promise },
    })
    assert.equal(state.updateWorkspaceFileDraft(key, { fingerprint, text: "small" }, () => {}), true)
    const closing = state.flushWorkspaceFileDraftsForClose()
    await started.promise
    assert.equal(state.updateWorkspaceFileDraft(key, { fingerprint, text: "x".repeat(256 * 1024) }, () => {}), false)
    release.resolve(true)
    await assert.rejects(closing, state.WorkspaceDraftFlushError)
  })
  it("shares an in-flight draft recovery with the replacement reader", async () => {
    const key = "checkout/file", kept = { key, fingerprint: "0".repeat(64), text: "newer than disk" }
    const read = deferred<unknown>()
    let reads = 0
    const state = await boot({
      loadClientState: async () => loadResult(),
      loadFileDrafts: () => { reads++; return read.promise },
    })
    const departed = state.refreshWorkspaceFileDraft(key)
    const reopened = state.refreshWorkspaceFileDraft(key)
    read.resolve([kept])
    assert.deepEqual(await Promise.all([departed, reopened]), [kept, kept])
    assert.equal(reads, 1)
  })

  it("rechecks authored drafts before close and retries a refused discard", async () => {
    const key = "checkout/file", value = { fingerprint: "0".repeat(64), text: "latest edit" }
    let stored: typeof value | null = null, failDelete = false
    const state = await boot({
      loadClientState: async () => loadResult(),
      setClientStateRestoreEnabled: async () => true,
      loadFileDrafts: async () => stored ? [{ key, ...stored }] : [],
      saveFileDraft: async (_token, change) => {
        if (!change.draft && failDelete) throw new Error("store briefly unavailable")
        if (stored?.text !== change.expected?.text) return false
        stored = change.draft
        return true
      },
    })
    await state.setRestorePreviousStateEnabled(false)
    state.updateWorkspaceFileDraft(key, { ...value, text: "first edit" }, () => {})
    await state.setRestorePreviousStateEnabled(true)
    state.updateWorkspaceFileDraft(key, value, () => {})
    await state.flushWorkspaceFileDraftsForClose()
    assert.deepEqual(stored, value)
    stored = null // Another renderer discarded its recovered copy.
    await state.flushWorkspaceFileDraftsForClose()
    assert.deepEqual(stored, value)
    failDelete = true
    state.updateWorkspaceFileDraft(key, null, () => {})
    await assert.rejects(state.flushWorkspaceFileDraftsForClose(), state.WorkspaceDraftFlushError)
    failDelete = false
    await state.flushWorkspaceFileDraftsForClose()
    assert.equal(stored, null)
  })
  it("protects a recovered draft that remained open when another window discarded it", async () => {
    const key = "checkout/file", value = { fingerprint: "0".repeat(64), text: "recovered draft" }
    let stored: typeof value | null = value
    const state = await boot({
      loadClientState: async () => loadResult(),
      loadFileDrafts: async () => stored ? [{ key, ...stored }] : [],
      saveFileDraft: async (_token, change) => {
        if (stored?.text !== change.expected?.text) return false
        stored = change.draft
        return true
      },
    })
    state.keepRecoveredWorkspaceFileDraft((await state.refreshWorkspaceFileDraft(key))!)
    stored = null
    await state.flushWorkspaceFileDraftsForClose()
    assert.deepEqual(stored, value)
  })
  for (const localCopy of [false, true]) it(`retains occurrence browser resources when the shared layout is full (${localCopy ? "matching local copy" : "new key"}) and retries on reload`, async () => {
    const browser = { mode: "preview", targetUrl: "https://example.com/saved", viewport: "mobile",
      history: { urls: ["https://example.com/start", "https://example.com/saved"], index: 1 } }
    const workspace = { kind: "workspace", folder: "/same", activeSessionId: "session",
      drafts: {}, attachments: {}, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {},
      viewState: { version: 1, previews: { session: browser } } }
    let saved: any
    const api = {
      loadClientState: async () => loadResult(saved ?? { ...snapshot("unused",
        Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`entry-${i}`, "saved"]))),
        session: { tabs: [workspace], activeTabIndex: 0 } }),
      saveClientState: async (_token: string, value: any) => { saved = value; return true },
    }
    const storage = new MemoryStorage()
    if (localCopy) storage.setItem("opencode-session-browser-state-v1", JSON.stringify({ session: { ...browser, mode: "chat" } }))
    const state = await boot(api, storage)
    state.updateRestorableSession(state.loadedRestorableSession())
    await state.flushClientState()
    assert.equal(Object.hasOwn(saved.layout, "opencode-session-browser-state-v1"), false)
    assert.deepEqual(saved.session.tabs[0].viewState.previews.session, browser)
    state.removeClientLayoutValue("entry-0")
    await state.flushClientState()
    const reloaded = await boot(api, storage)
    await reloaded.flushClientState()
    assert.deepEqual(JSON.parse(saved.layout["opencode-session-browser-state-v1"]).session, { ...browser, mode: "chat" })
    assert.deepEqual(saved.session.tabs[0].viewState.previews.session, { mode: "preview" })
  })
  it("merges imported duplicate browsers by session with active-descriptor priority and preserves modes", async () => {
    const workspace = (occurrence: number) => ({ kind: "workspace", folder: "/same", occurrence,
      activeSessionId: "session", drafts: {}, attachments: {}, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {},
      viewState: { version: 1, previews: { session: { mode: occurrence ? "chat" : "preview",
        targetUrl: `https://example.com/${occurrence}`, viewport: occurrence ? "mobile" : "desktop",
        history: { urls: ["https://example.com/start", `https://example.com/${occurrence}`], index: 1 } },
        [`only-${occurrence}`]: { mode: "chat", targetUrl: `https://example.com/only-${occurrence}` } } } })
    let saved: any
    const state = await boot({
      loadClientState: async () => loadResult({ ...snapshot("unused"),
        session: { tabs: [workspace(0), workspace(1)], activeTabIndex: 1 } }),
      saveClientState: async (_token, value) => { saved = value; return true },
    })
    const browsers = JSON.parse(state.readClientLayoutValue("opencode-session-browser-state-v1")!)
    assert.equal(browsers.session.targetUrl, "https://example.com/1")
    assert.equal(browsers.session.viewport, "mobile")
    assert.deepEqual(browsers.session.history, { urls: ["https://example.com/start", "https://example.com/1"], index: 1 })
    assert.equal(browsers["only-0"].targetUrl, "https://example.com/only-0")
    assert.equal(browsers["only-1"].targetUrl, "https://example.com/only-1")
    await state.flushClientState()
    assert.deepEqual(saved.session.tabs.map((tab: any) => tab.viewState.previews.session), [{ mode: "preview" }, { mode: "chat" }])
    assert.equal(JSON.parse(saved.layout["opencode-session-browser-state-v1"]).session.targetUrl, browsers.session.targetUrl)
  })
  it("publishes migrated descriptor views before retiring legacy preview entries; failed publication retains the source", async () => {
    const key = "opencode-session-previews-v1"
    const source = JSON.stringify({ '[\"/same\",\"session\"]': { targetUrl: "https://example.com/", mode: "preview" } })
    const storage = new MemoryStorage(), saved: any[] = []
    storage.setItem(key, source)
    const workspace = { kind: "workspace", folder: "/same", activeSessionId: "session",
      drafts: {}, attachments: {}, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {} }
    let fail = true
    const state = await boot({
      loadClientState: async () => loadResult({ ...snapshot("unused", { [key]: source }),
        session: { tabs: [workspace, { ...workspace, occurrence: 1 }], activeTabIndex: 0 } }),
      saveClientState: async (_token, value) => {
        saved.push(value)
        assert.ok(value.session.tabs.every((tab: any) => tab.viewState.previews.session.mode === "preview"))
        assert.equal(JSON.parse(value.layout["opencode-session-browser-state-v1"]).session.targetUrl, "https://example.com/")
        if (fail) throw new Error("publication failed")
        return true
      },
    }, storage)
    await assert.rejects(state.flushClientState(), /publication failed/)
    assert.equal(storage.getItem(key), source)
    fail = false
    await state.flushClientState()
    assert.equal(saved.find(value => value.layout[key] === source)?.session.tabs.length, 2)
    assert.equal(saved.at(-1).layout[key], "{}")
    assert.equal(storage.getItem(key), "{}")
  })
  it("preserves a concurrent legacy preview write during migration publication", async () => {
    const key = "opencode-session-previews-v1", storage = new MemoryStorage()
    const source = JSON.stringify({ '[\"/same\",\"session\"]': { targetUrl: "https://example.com/a", mode: "preview" } })
    const concurrent = JSON.stringify({ '[\"/same\",\"session\"]': { targetUrl: "https://example.com/b", mode: "chat" } })
    const workspace = { kind: "workspace", folder: "/same", activeSessionId: "session",
      drafts: {}, attachments: {}, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {} }
    storage.setItem(key, source)
    const saved: any[] = []
    const state = await boot({
      loadClientState: async () => loadResult({ ...snapshot("unused", { [key]: source }),
        session: { tabs: [workspace], activeTabIndex: 0 } }),
      saveClientState: async (_token, value) => {
        saved.push(value)
        storage.setItem(key, concurrent)
        return true
      },
    }, storage)
    await state.flushClientState()
    assert.equal(storage.getItem(key), concurrent)
    assert.equal(saved.at(-1).layout[key], concurrent)
  })
  it("removes layout entries from native and legacy storage, freeing the bounded budget", async () => {
    const entries = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`entry-${i}`, "saved"]))
    const saved: any[] = [], storage = new MemoryStorage()
    storage.setItem("entry-0", "saved")
    const state = await boot({ loadClientState: async () => loadResult(snapshot("saved", entries)),
      saveClientState: async (_token, value) => { saved.push(value); return true },
    }, storage)
    state.removeClientLayoutValue("entry-0")
    state.writeClientLayoutValue("replacement", "new")
    await state.flushClientState()
    assert.equal(state.readClientLayoutValue("entry-0"), null)
    assert.equal(storage.getItem("entry-0"), null)
    assert.equal(Object.keys(saved.at(-1).layout).length, 64)
    assert.equal(saved.at(-1).layout.replacement, "new")
  })
  it("retains layout removals when a concurrent destructive transaction fails", async () => {
    const operation = deferred<boolean>(), started = deferred<void>(), saved: any[] = []
    const storage = new MemoryStorage()
    storage.setItem(layoutKey, "saved")
    const state = await boot({ loadClientState: async () => loadResult(snapshot("saved", { [layoutKey]: "saved" })),
      clearClientState: () => { started.resolve(); return operation.promise },
      saveClientState: async (_token, value) => { saved.push(value); return true },
    }, storage)
    const clearing = state.clearRestoredClientState()
    await started.promise
    state.removeClientLayoutValue(layoutKey)
    operation.reject(new Error("fixture clear failed"))
    await assert.rejects(clearing, /fixture clear failed/)
    await state.flushClientState()
    assert.equal(storage.getItem(layoutKey), null)
    assert.equal(state.readClientLayoutValue(layoutKey), null)
    assert.equal(saved.at(-1).layout[layoutKey], undefined)
  })
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
  it("flushes the latest draft after a held autosave without replaying older deadlines", async t => {
    const started = deferred<void>(), release = deferred<boolean>()
    const writes: string[] = []
    const state = await boot({
      loadClientState: async () => loadResult(),
      saveClientState: async (_token, snapshot) => {
        writes.push(snapshot.session.tabs[0].drafts.conversation)
        if (writes.length > 1) return true
        started.resolve()
        return release.promise
      },
    })
    t.mock.timers.enable({ apis: ["setTimeout"] })
    const edit = (draft: string) => state.updateRestorableSession({
      activeTabIndex: 0, tabs: [{
        kind: "workspace", folder: "/repo", drafts: { conversation: draft },
        attachments: {}, unseenIdleSince: {}, generationRecovery: {}, scrollSnapshots: {},
      }],
    })
    edit("in flight")
    t.mock.timers.tick(500)
    await started.promise
    for (const draft of ["obsolete one", "obsolete two", "latest"]) {
      edit(draft)
      t.mock.timers.tick(500)
    }
    const closing = state.flushClientState()
    assert.deepEqual(writes, ["in flight"])
    release.resolve(true)
    await closing
    assert.deepEqual(writes, ["in flight", "latest"])
  })

  it("closes successfully after waiting for a retry that supersedes a failed autosave", async t => {
    const started = deferred<void>(), release = deferred<boolean>()
    const writes: string[] = []
    const state = await boot({
      loadClientState: async () => loadResult(),
      saveClientState: async (_token, snapshot) => {
        writes.push(snapshot.session.tabs[0].sidecarId)
        if (writes.length === 1) throw new Error("transient save failure")
        started.resolve()
        return release.promise
      },
    })
    t.mock.timers.enable({ apis: ["setTimeout"] })
    state.updateRestorableSession(session("first"))
    t.mock.timers.tick(500)
    await setImmediate()
    assert.deepEqual(writes, ["first"])

    state.updateRestorableSession(session("latest"))
    t.mock.timers.tick(500)
    await started.promise
    const closing = state.flushClientState()
    release.resolve(true)
    await closing
    assert.deepEqual(writes, ["first", "latest"])
  })

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
  for (const host of ["electron secondary", "plain web without sessionStorage"] as const) {
    it(`${host}: keeps layout local without restoring or writing snapshots`, async () => {
      const storage = new MemoryStorage(); storage.setItem(layoutKey, "360")
      const web = host === "plain web without sessionStorage"
      let saves = 0
      if (web) {
        storage.setItem("codenomad-client-snapshot-v1", JSON.stringify(snapshot("private")))
        storage.setItem("codenomad-client-restore-enabled-v1", "false")
      } else storage.removeItem(layoutKey)
      const state = await boot(web ? undefined : {
        loadClientState: async () => loadResult(snapshot("docs", { [layoutKey]: "380" }), false),
        saveClientState: async () => { saves += 1; return false },
      }, storage)
      assert.equal(state.clientStateIsPrimary(), false)
      assert.equal(state.loadedRestorableSession(), null)
      assert.equal(state.readClientLayoutValue(layoutKey), web ? "360" : null)
      state.writeClientLayoutValue(layoutKey, "420"); state.updateRestorableSession(session("other"))
      await state.flushClientState()
      assert.equal(storage.getItem(layoutKey), "420")
      assert.equal(saves, 0)
      if (web) {
        assert.equal(storage.getItem("codenomad-client-snapshot-v1"), null)
        assert.equal(storage.getItem("codenomad-client-restore-enabled-v1"), null)
      }
    })
  }
})

describe("plain web tab session", () => {
  const SNAPSHOT_KEY = "codenomad.client-state.v1"
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
  before(() => {
    Object.defineProperty(globalThis, "document", { configurable: true, value: { wasDiscarded: false } })
  })
  after(() => {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument)
    else Reflect.deleteProperty(globalThis, "document")
  })
  const bootWeb = async (tab: MemoryStorage, storage = new MemoryStorage()) => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage, sessionStorage: tab } })
    const state = await import(`./client-state.ts?test=${moduleId++}`) as ClientState
    await state.initializeClientState()
    return state
  }
  for (const concurrent of [false, true]) it(`migrates occurrence views into the web snapshot, retaining shared layout and ${concurrent ? "concurrent sources" : "retiring accepted sources"}`, async () => {
    const tab = new MemoryStorage(), storage = new MemoryStorage()
    const previewKey = "opencode-session-previews-v1", missionKey = `mission-project-${compactMissionKey("/same")}`
    const source = JSON.stringify({ '["/same","session"]': { targetUrl: "https://example.com/", mode: "preview" } })
    const mission = JSON.stringify({ selected: "mission", reader: { missionId: "mission", kind: "report", itemId: "report", instanceId: "old" } })
    const workspace = { kind: "workspace", folder: "/same", activeSessionId: "session",
      drafts: {}, attachments: {}, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {} }
    tab.setItem(SNAPSHOT_KEY, JSON.stringify({ ...snapshot("unused"), session: { tabs: [
      workspace, { ...workspace, occurrence: 1 }, { ...workspace, occurrence: 2, viewState: { version: 1 } },
    ], activeTabIndex: 0 } }))
    storage.setItem(previewKey, source)
    storage.setItem(missionKey, mission)
    storage.setItem(layoutKey, "420")
    const write = tab.setItem.bind(tab)
    let fail = true
    tab.setItem = (key, value) => {
      if (fail) throw new Error("QuotaExceededError")
      if (concurrent) {
        storage.setItem(previewKey, "{}")
        storage.setItem(missionKey, JSON.stringify({ selected: "newer" }))
      }
      write(key, value)
    }
    const state = await bootWeb(tab, storage)
    await assert.rejects(state.flushClientState(), /refused the client snapshot/)
    assert.equal(storage.getItem(previewKey), source)
    assert.equal(storage.getItem(missionKey), mission)
    fail = false
    await state.flushClientState()
    const saved = JSON.parse(tab.getItem(SNAPSHOT_KEY)!)
    assert.deepEqual(saved.layout, {})
    const views = saved.session.tabs.map((tab: any) => tab.viewState)
    assert.equal(views[0].missions.selected, "mission")
    assert.equal(views[1].missions, undefined)
    assert.deepEqual(views[0].previews.session, { mode: "preview" })
    assert.deepEqual(views[1].previews.session, { mode: "preview" })
    assert.equal(JSON.parse(storage.getItem("opencode-session-browser-state-v1")!).session.targetUrl, "https://example.com/")
    assert.deepEqual(views[2], { version: 1 })
    assert.equal(storage.getItem(previewKey), "{}")
    assert.equal(storage.getItem(missionKey), concurrent ? JSON.stringify({ selected: "newer" }) : null)
    assert.equal(storage.getItem(layoutKey), "420")
    const reloaded = await bootWeb(tab, storage)
    assert.deepEqual(reloaded.loadedRestorableSession(), normalizeRestorableSession(saved.session))
    await reloaded.flushClientState()
  })
  it("restores the tab's own snapshot after a reload and saves changes back to sessionStorage only", async () => {
    const tab = new MemoryStorage(), storage = new MemoryStorage()
    tab.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot("saved")))
    const state = await bootWeb(tab, storage)
    assert.equal(state.clientStateIsPrimary(), true)
    assert.equal(state.restorePreviousStateEnabled(), true)
    assert.deepEqual(state.loadedRestorableSession(), session("saved"))
    state.updateRestorableSession(session("next"))
    await state.flushClientState()
    assert.deepEqual(JSON.parse(tab.getItem(SNAPSHOT_KEY)!).session, session("next"))
    const reloaded = await bootWeb(tab, storage)
    assert.deepEqual(reloaded.loadedRestorableSession(), session("next"))
    assert.equal(storage.getItem("codenomad-client-snapshot-v1"), null)
  })
  it("keeps layout values in shared localStorage, written and read immediately and kept by Clear", async () => {
    const tab = new MemoryStorage(), storage = new MemoryStorage()
    tab.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot("saved", { [layoutKey]: "300" })))
    storage.setItem(layoutKey, "360")
    const state = await bootWeb(tab, storage)
    assert.equal(state.readClientLayoutValue(layoutKey), "360")
    state.writeClientLayoutValue(layoutKey, "420")
    assert.equal(storage.getItem(layoutKey), "420")
    assert.equal((await bootWeb(tab, storage)).readClientLayoutValue(layoutKey), "420", "a reload before the snapshot save reads the latest value")
    state.updateRestorableSession(session("next"))
    await state.flushClientState()
    assert.deepEqual(JSON.parse(tab.getItem(SNAPSHOT_KEY)!).layout, {})
    await state.clearRestoredClientState()
    assert.equal(tab.getItem(SNAPSHOT_KEY), null)
    assert.equal(storage.getItem(layoutKey), "420")
  })
  it("starts empty and remembers a disabled restore for the tab; clearing removes its snapshot", async () => {
    const tab = new MemoryStorage()
    const state = await bootWeb(tab)
    assert.equal(state.loadedRestorableSession(), null)
    state.updateRestorableSession(session("draft"))
    await state.flushClientState()
    await state.clearRestoredClientState()
    assert.equal(tab.getItem(SNAPSHOT_KEY), null)
    state.updateRestorableSession(session("again"))
    await state.flushClientState()
    await state.setRestorePreviousStateEnabled(false)
    assert.equal(tab.getItem(SNAPSHOT_KEY), null)
    const reloaded = await bootWeb(tab)
    assert.equal(reloaded.restorePreviousStateEnabled(), false)
    assert.equal(reloaded.loadedRestorableSession(), null)
    await reloaded.setRestorePreviousStateEnabled(true)
    assert.equal((await bootWeb(tab)).restorePreviousStateEnabled(), true)
  })
  it("a refused write (storage quota) fails that save only; Clear and later saves still work", async () => {
    const tab = new MemoryStorage(), setItem = tab.setItem.bind(tab)
    tab.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot("stale")))
    let full = true
    tab.setItem = (key, value) => { if (full) throw new Error("QuotaExceededError"); setItem(key, value) }
    const state = await bootWeb(tab)
    state.updateRestorableSession(session("large"))
    await assert.rejects(state.flushClientState(), /refused the client snapshot/)
    assert.equal(state.clientStateIsPrimary(), true)
    await state.clearRestoredClientState()
    assert.equal(tab.getItem(SNAPSHOT_KEY), null)
    full = false
    await state.setRestorePreviousStateEnabled(true)
    state.updateRestorableSession(session("small"))
    await state.flushClientState()
    assert.deepEqual(JSON.parse(tab.getItem(SNAPSHOT_KEY)!).session, session("small"))
  })
})

describe("partitioned client state", () => {
  for (const refusal of ["throw", "false"] as const) it(`resends the exact full snapshot after a delta ${refusal}`, async () => {
    const encoded = await encodeClientSnapshotV2(snapshot("restored"))
    const commits: any[] = []
    const state = await boot({
      loadClientState: async () => loadResult(encoded.root, true, 1),
      loadClientStatePartition: async (_token, key) => encoded.partitions[key] ?? null,
      commitClientStatePartitions: async (_token, value) => {
        commits.push(value)
        if (commits.length === 1) {
          assert.deepEqual(Object.keys(value.partitions), [])
          if (refusal === "throw") throw new Error("Missing client state partition")
          return false
        }
        return true
      },
    })
    state.writeClientLayoutValue(layoutKey, "420")
    await state.flushClientState()
    assert.equal(commits.length, 2)
    assert.deepEqual(commits[1].snapshot, commits[0].snapshot)
    assert.deepEqual(commits[1].partitions, encoded.partitions)
    assert.equal(state.clientStateIsPrimary(), true)
  })
  for (const kind of ["clear", "disable"] as const) it(`${kind}: removes optional persisted indexes and prevents their recapture`, async () => {
    const sessionState = { activeTabIndex: 0, tabs: [{ kind: "workspace" as const, folder: "/repo", activeSessionId: "s",
      drafts: { s: "draft" }, attachments: {}, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {},
      outlineIndexes: { s: normalizePersistedOutline({ format: 1, directory: "/repo", projectID: "p", entries: [],
        checkpoints: [{ after: -1, through: 0, digest: "a".repeat(64) }] })! } }] }
    const encoded = await encodeClientSnapshotV2({ ...snapshot("unused"), session: sessionState })
    let commits = 0
    const state = await boot({
      loadClientState: async () => loadResult(encoded.root, true, 1),
      loadClientStatePartition: async (_token, key) => encoded.partitions[key] ?? null,
      commitClientStatePartitions: async () => { commits++; return true },
      clearClientState: async () => true, setClientStateRestoreEnabled: async () => true,
    })
    assert.equal((state.loadedRestorableSession()?.tabs[0] as any).outlineIndexes.s.format, 1)
    await transact(state, kind)
    state.updateRestorableSession(sessionState)
    await state.flushClientState()
    assert.equal(state.loadedRestorableSession(), null)
    assert.equal(commits, 0)
  })
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

  it("skips an unchanged debounced commit, clears a stale error and republishes on flush", async (t) => {
    const encoded = await encodeClientSnapshotV2(snapshot("restored"))
    const commits: any[] = []
    const state = await boot({
      loadClientState: async () => loadResult(encoded.root, true, 1),
      loadClientStatePartition: async (_token, key) => encoded.partitions[key] ?? null,
      commitClientStatePartitions: async (_token, value) => { commits.push(value); return true },
      clearClientState: async () => true, setClientStateRestoreEnabled: async () => true,
    })
    const debounced = async (sidecar: string) => {
      state.updateRestorableSession(session(sidecar))
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    for (const sidecar of ["first", "first", "first", "second"]) await debounced(sidecar)
    assert.deepEqual(commits.map((commit) => commit.snapshot.revision), [2, 5])
    // A save that fails before committing, then a return to the committed graph,
    // leaves no stale error for the next flush.
    const digest = t.mock.method(crypto.subtle, "digest", async () => { throw new Error("digest failed") })
    await debounced("broken")
    digest.mock.restore()
    await debounced("second")
    assert.equal(commits.length, 2)
    // The skipped save left the host copy unverified: the next flush republishes it,
    // so a lost host copy heals, and a further flush has nothing left to write.
    await state.flushClientState()
    assert.equal(commits.length, 3)
    await state.flushClientState()
    assert.equal(commits.length, 3)
    // An explicit flush of a fresh capture republishes even an unchanged graph.
    state.updateRestorableSession(session("second"))
    await state.flushClientState()
    assert.equal(commits.length, 4)
    // Clearing forgets the committed graph, so the same state is written again.
    await state.clearRestoredClientState()
    await state.setRestorePreviousStateEnabled(true)
    await debounced("second")
    assert.equal(commits.length, 5)
  })

  it("republishes on the next flush after a failed clear", async () => {
    const encoded = await encodeClientSnapshotV2(snapshot("restored"))
    const commits: any[] = []
    const state = await boot({
      loadClientState: async () => loadResult(encoded.root, true, 1),
      loadClientStatePartition: async (_token, key) => encoded.partitions[key] ?? null,
      commitClientStatePartitions: async (_token, value) => { commits.push(value); return true },
      clearClientState: async () => { throw new Error("host unavailable") },
    })
    state.updateRestorableSession(session("kept"))
    await state.flushClientState()
    await assert.rejects(state.clearRestoredClientState(), /host unavailable/)
    await state.flushClientState()
    assert.equal(commits.length, 2)
  })

  it("forgets a commit recorded by an in-flight save when the clear then fails", async () => {
    const encoded = await encodeClientSnapshotV2(snapshot("restored"))
    const commits: any[] = []
    let gate: ReturnType<typeof deferred<void>> | null = null
    const state = await boot({
      loadClientState: async () => loadResult(encoded.root, true, 1),
      loadClientStatePartition: async (_token, key) => encoded.partitions[key] ?? null,
      commitClientStatePartitions: async (_token, value) => { await gate?.promise; commits.push(value); return true },
      clearClientState: async () => { throw new Error("host unavailable") },
    })
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    state.updateRestorableSession(session("a"))
    await state.flushClientState()
    gate = deferred<void>()
    state.updateRestorableSession(session("b"))
    await wait(400)
    const clear = state.clearRestoredClientState()
    gate.resolve()
    await assert.rejects(clear, /host unavailable/)
    state.updateRestorableSession(session("b"))
    await wait(400)
    assert.equal(commits.length, 3, "the identical capture rewrites the unknown host copy")
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
