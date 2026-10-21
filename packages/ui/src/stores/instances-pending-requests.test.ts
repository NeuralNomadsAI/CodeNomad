import assert from "node:assert/strict"
import { test } from "node:test"
import type { OpenCodeClient, PermissionRequest } from "@opencode/client"
import type { WorkspacePendingRequestsResponse } from "../../../server/src/api-types"
import { PENDING_REQUEST_SNAPSHOT_TIMEOUT_MS } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { HttpResponseError } from "../lib/retryable-file-search"
import { sdkManager } from "../lib/sdk-manager"
import {
  addInstance, removeInstance, updateInstance, syncPendingRequests, invalidatePendingRequestSync,
  addPermissionToQueue, getPermissionQueue, markPermissionReplied,
  addPendingForm, sendFormReply,
  incompletePendingRecovery, clearReloadableInstanceState,
} from "./instances"
import { getFormQueue, type FormWithLocation } from "./forms"
import { markFormSettled } from "./form-settlements"
import { sessions, seedRestoredSessionSelection, setSessions } from "./session-state"
import { createClientSession } from "../types/session"
import { captureWorktreeMoveReconciliation, getPendingWorktreeLocations, getPendingWorktreeSlug, getWorktrees, reloadWorktrees, setWorktreeSlugForParentSession } from "./worktrees"
import { sseManager } from "../lib/sse-manager"
import { getToastHistory } from "../lib/notifications"
import { tGlobal } from "../lib/i18n"
import { fetchSessions, removeSessionRuntimeState } from "./session-api"
import { setInstanceMetadata } from "./instance-metadata"

const permission = (id: string): PermissionRequest => ({ id, sessionID: "background", action: "read", resources: ["file"] })
const form = (id: string, sessionID = "global") => ({
  id, sessionID, title: "Question", fields: [{ key: "answer", type: "string", title: "Answer" }],
} satisfies FormWithLocation)
const snapshot = (directory: string, permissions: PermissionRequest[] = [], forms: FormWithLocation[] = []): WorkspacePendingRequestsResponse => ({
  supported: true, directories: [{ directory, status: "ok", locations: [{ location: { directory }, permissions, forms }] }],
})
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
const emptyLocation = (directory: string) => ({ location: { directory }, permissions: [], forms: [] })
// Harness instances live in /pending-fixture, so the warning title names that project.
// Newest first, like the notification history.
const recoveryWarnings = () => getToastHistory().filter((item) => item.title === tGlobal("interruption.recoveryIncomplete.title", { workspace: "pending-fixture" }))

let sequence = 0
function harness() {
  const id = `pending-fixture-${++sequence}`, directory = "/pending-fixture"
  const calls: string[] = []
  const client = {
    permission: { request: { list: async ({ location }: any) => { calls.push(`permission:${location.directory}`); return { location, data: [] } } } },
    form: { list: async ({ location }: any) => { calls.push(`form:${location.directory}`); return { location, data: [] } } },
  } as unknown as OpenCodeClient
  const original = serverApi.getPendingRequests
  addInstance({ id, folder: directory, port: 0, pid: 0, proxyPath: "", status: "ready", client })
  return { id, directory, calls, client, cleanup() {
    serverApi.getPendingRequests = original
    removeInstance(id, { authoritative: false })
    setSessions((previous) => { const next = new Map(previous); next.delete(id); return next })
  } }
}

test("eight-directory snapshots avoid ordinary pending lists with 100 cold historical and 100 worktree locations", async () => {
  const h = harness()
  const originalWorktrees = serverApi.fetchWorktrees
  try {
    serverApi.fetchWorktrees = async () => ({ worktrees: Array.from({ length: 100 }, (_, index) => ({
      slug: `worktree-${index}`, directory: `/worktree-${index}`, kind: "worktree" as const,
    })) })
    await reloadWorktrees(h.id)
    setSessions(new Map([[h.id, new Map(Array.from({ length: 100 }, (_, index) => {
      const session = createClientSession({ id: `cold-${index}`, title: "Cold", location: { directory: `/cold-${index}` }, time: { created: 1, updated: 1 } } as any, h.id)
      return [session.id, session]
    }))]]))
    let calls = 0
    const pending = deferred<WorkspacePendingRequestsResponse>()
    const batches: string[][] = []
    serverApi.getPendingRequests = async (_id, directories) => {
      calls++; batches.push(directories)
      await pending.promise
      return { supported: true, directories: directories.map((directory) => ({ directory, status: "ok", locations:
        directory === h.directory ? [{ location: { directory }, permissions: [permission("remote")], forms: [form("external-global")] }] : [emptyLocation(directory)],
      })) }
    }
    const first = syncPendingRequests(h.id), second = syncPendingRequests(h.id)
    assert.equal(first, second)
    pending.resolve(snapshot(h.directory, [permission("remote")], [form("external-global")]))
    await first
    assert.equal(calls, 26)
    assert.deepEqual(batches.map((batch) => batch.length), [...Array(25).fill(8), 1])
    assert.equal(batches.flat().length, 201)
    assert.deepEqual(h.calls, [])
    assert.deepEqual(getPermissionQueue(h.id).map((entry) => entry.id), ["remote"])
    assert.equal(getFormQueue(h.id)[0]?.location?.directory, h.directory)
  } finally { serverApi.fetchWorktrees = originalWorktrees; h.cleanup() }
})

test("partial and cold coverage only prune matching known locations; unknown queues survive", async () => {
  const h = harness()
  try {
    addPermissionToQueue(h.id, permission("stale"), h.directory)
    addPermissionToQueue(h.id, permission("failed"), "/failed")
    addPermissionToQueue(h.id, permission("unknown"))
    addPendingForm(h.id, form("stale"), h.directory)
    addPendingForm(h.id, form("failed"), "/failed")
    addPendingForm(h.id, form("unknown"))
    serverApi.getPendingRequests = async () => ({ supported: true, directories: [
      { directory: h.directory, status: "ok", locations: [emptyLocation(h.directory)] }, { directory: "/failed", status: "error" },
    ] })
    await assert.rejects(syncPendingRequests(h.id))
    assert.deepEqual(getPermissionQueue(h.id).map((entry) => entry.id), ["failed", "unknown"])
    assert.deepEqual(getFormQueue(h.id).map((entry) => entry.id), ["failed", "unknown"])
    assert.deepEqual(h.calls, [])
  } finally { h.cleanup() }
})

test("loaded-only recovery outlives the old ten-second deadline but still times out and retains queues", async (t) => {
  const h = harness()
  t.mock.timers.enable({ apis: ["setTimeout"] })
  try {
    addPermissionToQueue(h.id, permission("known"), h.directory)
    addPendingForm(h.id, form("known"), h.directory)
    const started = deferred<AbortSignal>()
    serverApi.getPendingRequests = async (_id, _directories, signal) => new Promise((resolve, reject) => {
      assert.ok(signal)
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      started.resolve(signal)
      setTimeout(() => resolve(snapshot(h.directory, [permission("known"), permission("recovered")], [form("known"), form("recovered")])), 19_000)
    })
    const syncing = syncPendingRequests(h.id)
    const signal = await started.promise
    t.mock.timers.tick(10_001)
    assert.equal(signal.aborted, false, "a valid broker read must not be aborted at the old client deadline")
    t.mock.timers.tick(8_999)
    await syncing
    assert.equal(incompletePendingRecovery().has(h.id), false)
    assert.deepEqual(getPermissionQueue(h.id).map((request) => request.id), ["known", "recovered"])
    assert.deepEqual(getFormQueue(h.id).map((request) => request.id), ["known", "recovered"])

    const stalled = deferred<AbortSignal>()
    serverApi.getPendingRequests = async (_id, _directories, nextSignal) => new Promise((_resolve, reject) => {
      assert.ok(nextSignal)
      nextSignal.addEventListener("abort", () => reject(nextSignal.reason), { once: true })
      stalled.resolve(nextSignal)
    })
    const stalledSync = syncPendingRequests(h.id)
    const rejected = assert.rejects(stalledSync)
    const stalledSignal = await stalled.promise
    t.mock.timers.tick(PENDING_REQUEST_SNAPSHOT_TIMEOUT_MS)
    assert.equal(stalledSignal.aborted, false)
    t.mock.timers.tick(5_000)
    await rejected
    assert.equal(stalledSignal.aborted, true)
    assert.equal(incompletePendingRecovery().has(h.id), true)
    assert.deepEqual(getPermissionQueue(h.id).map((request) => request.id), ["known", "recovered"])
    assert.deepEqual(getFormQueue(h.id).map((request) => request.id), ["known", "recovered"])
    assert.deepEqual(h.calls, [], "a slow or unavailable broker never falls back to ordinary pending lists")
  } finally { h.cleanup(); t.mock.timers.reset() }
})

test("obsolete and foreign history can be excluded without repeated warnings or losing valid idle requests", async () => {
  const h = harness()
  try {
    const deleted = "/deleted-temporary-history", foreign = `${h.directory}/foreign-fixture`, subdirectory = `${h.directory}/idle-subdirectory`
    const warnings = () => recoveryWarnings().length
    const before = warnings()
    setSessions((previous) => new Map(previous).set(h.id, new Map([deleted, foreign, subdirectory].map((directory, index) => {
      const session = createClientSession({ id: `history-${index}`, title: "History", location: { directory }, time: { created: 1, updated: 1 } } as any, h.id)
      return [session.id, session]
    }))))
    serverApi.getPendingRequests = async (_id, directories, _signal, optional) => {
      assert(optional?.includes(deleted) && optional.includes(foreign))
      return { supported: true, directories: directories.map((directory) => directory === deleted || directory === foreign
        ? { directory, status: "excluded" as const }
        : { directory, status: "ok" as const, locations: [{ location: { directory },
          permissions: directory === subdirectory ? [permission("idle")] : [], forms: directory === subdirectory ? [form("idle")] : [],
        }] }) }
    }
    await syncPendingRequests(h.id)
    await syncPendingRequests(h.id)
    assert.equal(incompletePendingRecovery().has(h.id), false)
    assert.equal(warnings(), before, "two successful recoveries with excluded hints must not emit the incomplete warning")
    assert.deepEqual(getPermissionQueue(h.id).map((request) => request.id), ["idle"])
    assert.deepEqual(getFormQueue(h.id).map((request) => request.id), ["idle"])
    assert.equal(sessions().get(h.id)?.size, 3, "excluding a recovery hint never deletes its historical session")
    assert.deepEqual(h.calls, [])
  } finally { h.cleanup() }
})

test("known permission/Form authority and active sessions cannot be excluded as obsolete history", async () => {
  const h = harness()
  try {
    const activeDirectory = "/active-session", permissionDirectory = "/known-permission", formDirectory = "/known-form"
    const active = createClientSession({ id: "active", title: "Active", location: { directory: activeDirectory }, time: { created: 1, updated: 1 } } as any, h.id, "", undefined, "working")
    setSessions((previous) => new Map(previous).set(h.id, new Map([[active.id, active]])))
    addPermissionToQueue(h.id, permission("known"), permissionDirectory)
    addPendingForm(h.id, form("known"), formDirectory)
    const draft = getFormQueue(h.id)[0]
    serverApi.getPendingRequests = async (_id, directories, _signal, optional) => {
      assert.deepEqual(optional, [])
      assert.deepEqual(new Set(directories), new Set([h.directory, activeDirectory, permissionDirectory, formDirectory]))
      return { supported: true, directories: directories.map((directory) => directory === h.directory
        ? { directory, status: "ok" as const, locations: [emptyLocation(directory)] }
        : { directory, status: "excluded" as const }) }
    }
    await assert.rejects(syncPendingRequests(h.id))
    assert.equal(incompletePendingRecovery().has(h.id), true)
    assert.equal(getFormQueue(h.id)[0], draft)
    assert.deepEqual(getPermissionQueue(h.id).map((request) => request.id), ["known"])
    assert.deepEqual(h.calls, [])
  } finally { h.cleanup() }
})

test("recovery reconciles stale inventoried worktrees before warning about removed idle history", async () => {
  const h = harness()
  const original = serverApi.fetchWorktrees
  const deleted = `${h.directory}/deleted-worktree`
  try {
    serverApi.fetchWorktrees = async () => ({ worktrees: [{ slug: "deleted", directory: deleted, kind: "worktree" }] })
    await reloadWorktrees(h.id)
    const history = createClientSession({ id: "history", title: "Preserved history", location: { directory: deleted }, time: { created: 1, updated: 1 } } as any, h.id)
    setSessions(previous => new Map(previous).set(h.id, new Map([[history.id, history]])))
    let refreshes = 0, reads = 0
    serverApi.fetchWorktrees = async (_id, fresh) => {
      assert.equal(fresh, true, "recovery must bypass the warm server display cache")
      refreshes++
      return { worktrees: [{ slug: "root", directory: h.directory, kind: "root" }] }
    }
    serverApi.getPendingRequests = async (_id, directories, _signal, optional) => {
      reads++
      return { supported: true, directories: directories.map(directory => directory === deleted
        ? optional?.includes(directory) ? { directory, status: "excluded" as const } : { directory, status: "error" as const, reason: "missing" as const }
        : { directory, status: "ok" as const, locations: [{ location: { directory }, permissions: [permission("other")], forms: [form("other")] }] }) }
    }
    const before = recoveryWarnings().length
    await syncPendingRequests(h.id)
    await syncPendingRequests(h.id)
    assert.equal(refreshes, 1)
    assert.equal(reads, 3, "only the changed inventory warrants one new loaded-only snapshot")
    assert.equal(incompletePendingRecovery().has(h.id), false)
    assert.equal(recoveryWarnings().length, before)
    assert.equal(sessions().get(h.id)?.get(history.id)?.location.directory, deleted)
    assert.equal(sessions().get(h.id)?.get(history.id)?.title, history.title)
    assert.deepEqual(getWorktrees(h.id).map(entry => entry.slug), ["root"])
    assert.deepEqual(getPermissionQueue(h.id).map(entry => entry.id), ["other"])
    assert.deepEqual(getFormQueue(h.id).map(entry => entry.id), ["other"])
    assert.deepEqual(h.calls, [])
  } finally { serverApi.fetchWorktrees = original; h.cleanup() }
})

for (const unsupported of [false, true]) test(`a failed inventory-only retry preserves sibling recovery (unsupported=${unsupported})`, async () => {
  const h = harness(), original = serverApi.fetchWorktrees
  const deleted = `${h.directory}/removed-inventory-only`
  try {
    serverApi.fetchWorktrees = async () => ({ worktrees: [{ slug: "deleted", directory: deleted, kind: "worktree" }] })
    await reloadWorktrees(h.id)
    serverApi.fetchWorktrees = async () => ({ worktrees: [] })
    let reads = 0
    serverApi.getPendingRequests = async (_id, directories, _signal, optional) => {
      if (++reads === 2) {
        assert.deepEqual(directories, [deleted], "retry only the reclassified failure, not every historical directory")
        assert.deepEqual(optional, [deleted])
        if (unsupported) return { supported: false }
        throw new Error("native reader unavailable")
      }
      return { supported: true, directories: [
        { directory: h.directory, status: "ok", locations: [{ location: { directory: h.directory }, permissions: [permission("sibling")], forms: [form("sibling")] }] },
        { directory: deleted, status: "error", reason: "missing" },
      ] }
    }
    await assert.rejects(syncPendingRequests(h.id))
    assert.equal(reads, 2)
    assert.deepEqual(getPermissionQueue(h.id).map(entry => entry.id), ["sibling"])
    assert.deepEqual(getFormQueue(h.id).map(entry => entry.id), ["sibling"])
  } finally { serverApi.fetchWorktrees = original; h.cleanup() }
})

for (const provenance of ["selected", "working", "permission", "form"] as const) {
  test(`missing inventoried ${provenance} locations remain required without inventory-driven exclusion`, async () => {
    const h = harness(), original = serverApi.fetchWorktrees
    const deleted = `${h.directory}/required-worktree`
    try {
      serverApi.fetchWorktrees = async () => ({ worktrees: [{ slug: "deleted", directory: deleted, kind: "worktree" }] })
      await reloadWorktrees(h.id)
      const session = createClientSession({ id: "required", title: "Required", location: { directory: deleted }, time: { created: 1, updated: 1 } } as any, h.id, "", undefined, provenance === "working" ? "working" : "idle")
      setSessions(previous => new Map(previous).set(h.id, new Map([[session.id, session]])))
      if (provenance === "selected") seedRestoredSessionSelection(h.id, session.id, session.id)
      if (provenance === "permission") addPermissionToQueue(h.id, permission("known"), deleted)
      if (provenance === "form") addPendingForm(h.id, form("known"), deleted)
      const queuedForm = getFormQueue(h.id)[0]
      let refreshes = 0
      serverApi.fetchWorktrees = async () => { refreshes++; return { worktrees: [] } }
      serverApi.getPendingRequests = async (_id, directories, _signal, optional) => {
        assert.ok(!optional?.includes(deleted))
        return { supported: true, directories: directories.map(directory => directory === deleted
          ? { directory, status: "error" as const, reason: "missing" as const }
          : { directory, status: "ok" as const, locations: [emptyLocation(directory)] }) }
      }
      await assert.rejects(syncPendingRequests(h.id))
      await assert.rejects(syncPendingRequests(h.id))
      assert.equal(refreshes, 0)
      assert.equal(incompletePendingRecovery().has(h.id), true)
      if (provenance === "permission") assert.equal(getPermissionQueue(h.id)[0]?.id, "known")
      if (provenance === "form") assert.equal(getFormQueue(h.id)[0], queuedForm)
      assert.deepEqual(h.calls, [])
    } finally { serverApi.fetchWorktrees = original; h.cleanup() }
  })
}

for (const outcome of ["failed", "unchanged", "permission-arrival", "form-arrival"] as const) {
  test(`inventory reconciliation remains non-authoritative after ${outcome}`, async () => {
    const h = harness(), original = serverApi.fetchWorktrees
    const deleted = `${h.directory}/removed-worktree`
    const stale = { worktrees: [{ slug: "deleted", directory: deleted, kind: "worktree" as const }] }
    try {
      serverApi.fetchWorktrees = async () => stale
      await reloadWorktrees(h.id)
      let refreshes = 0, reads = 0
      let queuedForm: FormWithLocation | undefined
      serverApi.fetchWorktrees = async () => {
        refreshes++
        if (outcome === "failed") throw new Error("inventory unavailable")
        if (outcome === "unchanged") return stale
        if (outcome === "permission-arrival") addPermissionToQueue(h.id, permission("arrived"), deleted)
        if (outcome === "form-arrival") { addPendingForm(h.id, form("arrived"), deleted); queuedForm = getFormQueue(h.id)[0] }
        return { worktrees: [] }
      }
      serverApi.getPendingRequests = async (_id, directories, _signal, optional) => {
        reads++
        assert.ok(!optional?.includes(deleted))
        return { supported: true, directories: directories.map(directory => directory === deleted
          ? { directory, status: "error" as const, reason: "missing" as const }
          : { directory, status: "ok" as const, locations: [emptyLocation(directory)] }) }
      }
      await assert.rejects(syncPendingRequests(h.id))
      assert.equal(refreshes, 1)
      assert.ok(reads <= 2, "a mutation fence may restart once, never replay indefinitely")
      assert.equal(incompletePendingRecovery().has(h.id), true)
      if (outcome === "permission-arrival") assert.equal(getPermissionQueue(h.id)[0]?.id, "arrived")
      if (outcome === "form-arrival") assert.equal(getFormQueue(h.id)[0], queuedForm)
      assert.deepEqual(h.calls, [])
    } finally { serverApi.fetchWorktrees = original; h.cleanup() }
  })
}

test("a settled move clears selector busy state without releasing unreconciled directory authority", async () => {
  const h = harness(), original = serverApi.fetchWorktrees
  try {
    serverApi.fetchWorktrees = async () => ({ worktrees: [{ slug: "target", directory: `${h.directory}/target`, kind: "worktree" }] })
    await reloadWorktrees(h.id)
    const root = createClientSession({ id: "root", location: { directory: h.directory }, time: { created: 1, updated: 1 } } as any, h.id)
    setSessions(previous => new Map(previous).set(h.id, new Map([[root.id, root]])))
    await setWorktreeSlugForParentSession(h.id, root.id, "target", { moveFamily: async () => {}, refreshSessions: async () => {} })
    assert.equal(getPendingWorktreeSlug(h.id, root.id), undefined, "missing metadata must not leave the selector disabled")
    assert.equal(getPendingWorktreeLocations(h.id).length, 2, "selector settlement is not directory recovery authority")
  } finally { serverApi.fetchWorktrees = original; h.cleanup() }
})

for (const disposition of ["native-deleted", "authoritative-remove", "outside-project", "stale-resident"] as const) {
  test(`complete post-move scope reconciles an absent ${disposition} family member`, async () => {
    const h = harness(), original = serverApi.fetchWorktrees, originalClient = sdkManager.createClient
    const target = `${h.directory}/removed-target`
    try {
      serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: [{ slug: "target", directory: target, kind: "worktree" }] })
      await reloadWorktrees(h.id)
      const root = createClientSession({ id: "scope-root", location: { directory: h.directory }, time: { created: 1, updated: 1 } } as any, h.id)
      const child = createClientSession({ id: "scope-child", parentID: root.id, location: { directory: h.directory }, time: { created: 1, updated: 1 } } as any, h.id)
      setSessions(previous => new Map(previous).set(h.id, new Map([[root.id, root], [child.id, child]])))
      await setWorktreeSlugForParentSession(h.id, root.id, "target", { moveFamily: async () => {}, refreshSessions: async () => { throw new Error("read failed") } })
      if (disposition === "native-deleted") sseManager["handleEvent"](h.id, { id: "deleted-child", created: Date.now(), durable: { aggregateID: child.id, seq: 1, version: 2 }, type: "session.deleted", location: { directory: h.directory }, data: { sessionID: child.id } })
      if (disposition === "authoritative-remove") removeSessionRuntimeState(h.id, child.id)
      if (disposition === "native-deleted" || disposition === "authoritative-remove") assert.equal(sessions().get(h.id)?.has(child.id), false)
      if (disposition === "outside-project") setSessions(previous => new Map(previous).set(h.id, new Map([[root.id, root], [child.id, { ...child, location: { directory: "/other-project" } }]])))
      let mode: "complete" | "error" | "pagination" | "activity-failure" = "complete"
      let activeTarget = false
      const nativeRoot = { id: root.id, projectID: "scope-project", title: "Root", location: { directory: h.directory }, time: { created: 1, updated: 2 } }
      const nativeActive = { ...nativeRoot, id: "active-target", location: { directory: target } }
      sdkManager.createClient = () => ({ session: {
        list: async (input: any) => {
          if (mode === "error" && input.project) throw new Error("inventory failed")
          return { data: [nativeRoot, ...(activeTarget ? [nativeActive] : [])], cursor: mode === "pagination" ? { next: "repeated" } : {} }
        }, active: async () => { if (mode === "activity-failure") throw new Error("activity failed"); return activeTarget ? { [nativeActive.id]: {} } : {} },
      } }) as unknown as OpenCodeClient
      await fetchSessions(h.id, { reset: true, strictStatus: true })
      assert.equal(getPendingWorktreeLocations(h.id).length, 2, "missing project metadata is not complete scope")
      setInstanceMetadata(h.id, { project: { id: "scope-project" } as any })
      for (const failed of ["error", "pagination"] as const) {
        mode = failed
        await assert.rejects(fetchSessions(h.id, { reset: true, strictStatus: true }))
        assert.equal(getPendingWorktreeLocations(h.id).length, 2, `${failed} is not authoritative absence`)
      }
      mode = "activity-failure"
      await fetchSessions(h.id, { reset: true, strictStatus: true })
      assert.equal(getPendingWorktreeLocations(h.id).length, 2)
      mode = "complete"
      setInstanceMetadata(h.id, { project: { id: "global" } as any })
      await fetchSessions(h.id, { reset: true, strictStatus: true })
      assert.equal(getPendingWorktreeLocations(h.id).length, 2, "directory-scoped global history cannot prove whole-project absence")
      setInstanceMetadata(h.id, { project: { id: "scope-project" } as any })
      serverApi.fetchWorktrees = async () => ({ worktrees: [{ slug: "root", directory: h.directory, kind: "root", directoryOnly: true }] })
      await reloadWorktrees(h.id)
      await fetchSessions(h.id, { reset: true, strictStatus: true })
      assert.equal(getPendingWorktreeLocations(h.id).length, 2, "directory-only coverage is not a complete owned project inventory")
      serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: [{ slug: "root", directory: h.directory, kind: "root" }] })
      await reloadWorktrees(h.id)
      await fetchSessions(h.id, { reset: true, strictStatus: true })
      await fetchSessions(h.id, { reset: true, strictStatus: true })
      assert.deepEqual(getPendingWorktreeLocations(h.id), [], "complete current scope proves absence; old resident IDs must not pin the hold")
      serverApi.getPendingRequests = async (_id, directories, _signal, optional) => {
        assert.ok(!optional?.includes(target), "active/known placements remain required independently of move holds")
        return { supported: true, directories: directories.map(directory => directory === target
          ? { directory, status: "error" as const, reason: "missing" as const }
          : { directory, status: "ok" as const, locations: [emptyLocation(directory)] }) }
      }
      activeTarget = true
      await fetchSessions(h.id, { reset: true, strictStatus: true })
      assert.equal(sessions().get(h.id)?.get(nativeActive.id)?.status, "working")
      await assert.rejects(syncPendingRequests(h.id))
      removeSessionRuntimeState(h.id, nativeActive.id)
      addPermissionToQueue(h.id, permission("still-known"), target)
      addPendingForm(h.id, form("still-known"), target)
      await assert.rejects(syncPendingRequests(h.id))
      assert.equal(getPermissionQueue(h.id)[0]?.id, "still-known")
      assert.equal(getFormQueue(h.id)[0]?.id, "still-known")
    } finally { serverApi.fetchWorktrees = original; sdkManager.createClient = originalClient; h.cleanup() }
  })
}

test("a failed partial family move retains source/target authority until complete post-move native reconciliation", async () => {
  const h = harness(), original = serverApi.fetchWorktrees
  const originalClient = sdkManager.createClient
  const deleted = `${h.directory}/move-target`
  try {
    serverApi.fetchWorktrees = async () => ({ worktrees: [
      { slug: "root", directory: h.directory, kind: "root" }, { slug: "target", directory: deleted, kind: "worktree" },
    ] })
    await reloadWorktrees(h.id)
    const root = createClientSession({ id: "move-root", location: { directory: h.directory }, time: { created: 1, updated: 1 } } as any, h.id)
    const child = createClientSession({ id: "move-child", parentID: root.id, location: { directory: h.directory }, time: { created: 1, updated: 1 } } as any, h.id)
    setSessions(previous => new Map(previous).set(h.id, new Map([[root.id, root], [child.id, child]])))
    let mutations = 0, refreshes = 0
    const preMoveRead = captureWorktreeMoveReconciliation(h.id)
    await assert.rejects(setWorktreeSlugForParentSession(h.id, child.id, "target", {
      moveFamily: async () => {
        mutations++
        // Native may have moved only one member before a lost reply/failed rollback.
        setSessions(previous => new Map(previous).set(h.id, new Map([[root.id, root], [child.id, { ...child, location: { directory: deleted } }]])))
        captureWorktreeMoveReconciliation(h.id)()
        assert.equal(getPendingWorktreeLocations(h.id).length, 2, "a read started during native effects cannot settle the move")
        throw new Error("partial move; rollback state unavailable")
      },
      refreshSessions: async () => { refreshes++; throw new Error("native reconciliation unavailable") },
    }))
    assert.equal(mutations, 1)
    assert.equal(refreshes, 2)
    assert.equal(getPendingWorktreeSlug(h.id, child.id), undefined, "settled failure must not leave the selector busy")
    preMoveRead()
    assert.equal(getPendingWorktreeLocations(h.id).length, 2, "a read begun before the move cannot settle unknown family effects")
    serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: [{ slug: "root", directory: h.directory, kind: "root" }] })
    await reloadWorktrees(h.id)
    serverApi.getPendingRequests = async (_id, directories, _signal, optional) => {
      assert.ok(directories.includes(deleted), "an uncertain target survives descriptor removal")
      assert.ok(!optional?.includes(deleted), "an apparently idle child is not settled move authority")
      return { supported: true, directories: directories.map(directory => directory === deleted
        ? { directory, status: "error" as const, reason: "missing" as const }
        : { directory, status: "ok" as const, locations: [emptyLocation(directory)] }) }
    }
    await assert.rejects(syncPendingRequests(h.id))
    assert.equal(mutations, 1, "recovery never replays the move")
    let activityFails = true
    const nativeFamily = [root, child].map(session => ({ id: session.id, parentID: session.parentId ?? undefined,
      projectID: "move-project", title: session.id, location: { directory: h.directory }, time: { created: 1, updated: 2 } }))
    setInstanceMetadata(h.id, { project: { id: "move-project" } as any })
    sdkManager.createClient = () => ({ session: { list: async () => ({ data: nativeFamily, cursor: {} }),
      active: async () => { if (activityFails) throw new Error("activity unavailable"); return {} },
    } }) as unknown as OpenCodeClient
    await fetchSessions(h.id, { reset: true, strictStatus: true })
    assert.equal(getPendingWorktreeLocations(h.id).length, 2, "history alone cannot settle a move when fresh activity failed")
    activityFails = false
    await fetchSessions(h.id, { reset: true, strictStatus: true })
    assert.deepEqual(getPendingWorktreeLocations(h.id), [])
    assert.equal(getPendingWorktreeSlug(h.id, child.id), undefined)
    serverApi.getPendingRequests = async () => snapshot(h.directory)
    await syncPendingRequests(h.id)
    assert.equal(incompletePendingRecovery().has(h.id), false)
  } finally { serverApi.fetchWorktrees = original; sdkManager.createClient = originalClient; h.cleanup() }
})

test("the recovery warning needs consecutive incomplete attempts and a success re-arms it", async () => {
  const h = harness()
  const warnings = () => recoveryWarnings().length
  try {
    const before = warnings()
    const fail = async () => {
      serverApi.getPendingRequests = async () => { throw new Error("Temporary transport failure") }
      await assert.rejects(syncPendingRequests(h.id))
    }
    const succeed = async () => {
      serverApi.getPendingRequests = async (_id, directories) => ({ supported: true, directories: directories.map((directory) => ({ directory, status: "ok" as const, locations: [emptyLocation(directory)] })) })
      await syncPendingRequests(h.id)
    }
    await fail()
    assert.equal(incompletePendingRecovery().has(h.id), true, "Incomplete state is immediate even without a warning")
    assert.equal(warnings(), before, "One transient failure does not warn")
    await succeed()
    await fail()
    assert.equal(warnings(), before, "Alternating success/failure never warns")
    await fail()
    assert.equal(warnings(), before + 1)
    await fail()
    assert.equal(warnings(), before + 1, "A persistent failure warns once")
    await succeed()
    await fail()
    await fail()
    assert.equal(warnings(), before + 2, "A new persistent failure after recovery warns again")
  } finally { h.cleanup() }
})

test("the recovery warning names its cause, the folders and the sessions that required them", async () => {
  const h = harness()
  try {
    // The live case: an active session in a checkout the server cannot verify for this project.
    const foreign = `${h.directory}/.codenomad/worktrees/prompt-replay-yield`
    const active = createClientSession({ id: "issues", title: "ISSUES Codenomad", location: { directory: foreign }, time: { created: 1, updated: 1 } } as any, h.id, "", undefined, "working")
    const idle = createClientSession({ id: "idle", title: "Idle elsewhere", location: { directory: foreign }, time: { created: 1, updated: 1 } } as any, h.id)
    setSessions((previous) => new Map(previous).set(h.id, new Map([[active.id, active], [idle.id, idle]])))
    serverApi.getPendingRequests = async (_id, directories) => ({ supported: true, directories: directories.map((directory) => directory === foreign
      ? { directory, status: "error" as const, reason: "not-owned" as const }
      : { directory, status: "ok" as const, locations: [emptyLocation(directory)] }) })
    const before = recoveryWarnings().length
    await assert.rejects(syncPendingRequests(h.id))
    await assert.rejects(syncPendingRequests(h.id))
    assert.equal(recoveryWarnings().length, before + 1)
    assert.equal(recoveryWarnings()[0]?.message, `${tGlobal("interruption.recoveryIssue.notOwned", { directories: "prompt-replay-yield" })} ${
      tGlobal("interruption.recoverySessions", { sessions: "ISSUES Codenomad" })}`, "only the session that made the folder required is named")

    // A success re-arms the warning; a whole failed batch then names each folder with its own cause.
    serverApi.getPendingRequests = async (_id, directories) => ({ supported: true, directories: directories.map((directory) => ({ directory, status: "ok" as const, locations: [emptyLocation(directory)] })) })
    await syncPendingRequests(h.id)
    serverApi.getPendingRequests = async () => { throw new DOMException("aborted", "AbortError") }
    await assert.rejects(syncPendingRequests(h.id))
    await assert.rejects(syncPendingRequests(h.id))
    assert.equal(recoveryWarnings().length, before + 2)
    const message = recoveryWarnings()[0]?.message ?? ""
    const [timeoutPrefix] = tGlobal("interruption.recoveryIssue.timeout", { directories: "\u0000" }).split("\u0000")
    assert(message.startsWith(timeoutPrefix), message)
    for (const name of ["pending-fixture", "prompt-replay-yield", "ISSUES Codenomad"]) assert(message.includes(name), message)
  } finally { h.cleanup() }
})

test("a refused batch shows each folder's real reason and leaves excluded history out", async () => {
  const h = harness()
  try {
    const gone = `${h.directory}/.codenomad/worktrees/gone`, history = "/old-history"
    const active = createClientSession({ id: "active", title: "Active", location: { directory: gone }, time: { created: 1, updated: 1 } } as any, h.id, "", undefined, "working")
    const old = createClientSession({ id: "old", title: "Old", location: { directory: history }, time: { created: 1, updated: 1 } } as any, h.id)
    setSessions((previous) => new Map(previous).set(h.id, new Map([[active.id, active], [old.id, old]])))
    serverApi.getPendingRequests = async () => {
      throw new HttpResponseError("Directory does not belong to workspace", 403, null, undefined, { directories: [
        { directory: gone, status: "error", reason: "missing" }, { directory: history, status: "excluded" },
      ] })
    }
    const before = recoveryWarnings().length
    await assert.rejects(syncPendingRequests(h.id))
    await assert.rejects(syncPendingRequests(h.id))
    assert.equal(recoveryWarnings().length, before + 1)
    const message = recoveryWarnings()[0]?.message ?? ""
    assert(message.includes(tGlobal("interruption.recoveryIssue.missing", { directories: "gone" })), message)
    assert(!message.includes("old-history"), "an excluded optional hint is not reported")
    assert(!message.includes(tGlobal("interruption.recoveryIssue.notOwned", { directories: "gone" })), "not mislabelled as outside the project")
  } finally { h.cleanup() }
})

test("an unavailable recovery plugin is named rather than reported as a generic failure", async () => {
  const h = harness()
  try {
    serverApi.getPendingRequests = async () => ({ supported: false })
    const before = recoveryWarnings().length
    await assert.rejects(syncPendingRequests(h.id))
    await assert.rejects(syncPendingRequests(h.id))
    assert.equal(recoveryWarnings().length, before + 1)
    assert.equal(recoveryWarnings()[0]?.message, tGlobal("interruption.recoveryCause.unsupported", { detail: "" }))
  } finally { h.cleanup() }
})

test("history transport failures remain errors and a late known request fences historical exclusion", async () => {
  const h = harness()
  try {
    const directory = "/historical-directory"
    const session = createClientSession({ id: "history", title: "History", location: { directory }, time: { created: 1, updated: 1 } } as any, h.id)
    setSessions((previous) => new Map(previous).set(h.id, new Map([[session.id, session]])))
    serverApi.getPendingRequests = async () => { throw new Error("Temporary transport failure") }
    await assert.rejects(syncPendingRequests(h.id))
    assert.equal(incompletePendingRecovery().has(h.id), true)
    const pending = deferred<WorkspacePendingRequestsResponse>()
    let reads = 0
    serverApi.getPendingRequests = async (_id, directories, _signal, optional) => {
      if (++reads === 1) { assert.deepEqual(optional, [directory]); return pending.promise }
      assert.deepEqual(optional, [])
      return { supported: true, directories: directories.map((directory) => ({ directory, status: "error" as const })) }
    }
    const syncing = syncPendingRequests(h.id)
    await Promise.resolve()
    addPermissionToQueue(h.id, { ...permission("late"), sessionID: session.id }, directory)
    pending.resolve({ supported: true, directories: [
      { directory: h.directory, status: "ok", locations: [emptyLocation(h.directory)] }, { directory, status: "excluded" },
    ] })
    await assert.rejects(syncing)
    assert.deepEqual(getPermissionQueue(h.id).map((request) => request.id), ["late"])
    assert.equal(incompletePendingRecovery().has(h.id), true)
    assert.deepEqual(h.calls, [])
  } finally { h.cleanup() }
})

test("real SSE background permissions and Forms use cold native authority, not WSL host or realpath aliases", async () => {
  const originalClient = sdkManager.createClient
  try {
    for (const [host, native] of [
      ["D:\\isolated-fixture", "/mnt/d/isolated-fixture"],
      ["C:\\alias-fixture", "C:\\canonical-fixture"],
    ]) {
      const h = harness()
      try {
        updateInstance(h.id, { folder: host })
        sdkManager.createClient = () => h.client
        for (const [suffix, directory] of [["native", native], ["alias", host]]) {
          sseManager["handleEvent"](h.id, {
            id: `permission-event-${suffix}`, created: Date.now(), type: "permission.asked", location: { directory },
            data: { ...permission(`orphan-${suffix}`), sessionID: `not-in-loaded-page-${suffix}` },
          })
          sseManager["handleEvent"](h.id, {
            id: `form-event-${suffix}`, created: Date.now(), type: "form.created", location: { directory },
            data: { form: form(`orphan-${suffix}`, `not-in-loaded-page-${suffix}`) },
          })
        }
        sseManager["handleEvent"](h.id, {
          id: "global-form-event", created: Date.now(), type: "form.created", location: { directory: native },
          data: { form: form("orphan-global") },
        })
        assert.equal(sessions().get(h.id)?.size ?? 0, 0)
        assert.equal(getPermissionQueue(h.id).length, 2)
        assert.equal(getFormQueue(h.id).length, 3)
        let candidates: string[] = []
        serverApi.getPendingRequests = async (_id, directories) => {
          candidates = directories
          return { supported: true, directories: [{ directory: host, status: "error" }] }
        }
        await assert.rejects(syncPendingRequests(h.id))
        assert.equal(getPermissionQueue(h.id).length, 2)
        assert.equal(getFormQueue(h.id).length, 3)
        serverApi.getPendingRequests = async () => ({ supported: true, directories: [{ directory: host, status: "ok", locations: [] }] })
        await assert.rejects(syncPendingRequests(h.id), "missing native coverage is still incomplete")
        assert.equal(getPermissionQueue(h.id).length, 2, "an outer UI alias is not native coverage")
        assert.equal(getFormQueue(h.id).length, 3, "empty placement provenance cannot clear Forms")
        serverApi.getPendingRequests = async (_id, directories) => {
          candidates = directories
          return { supported: true, directories: directories.map((directory) => ({ directory, status: "ok" as const,
            locations: [emptyLocation(native)],
          })) }
        }
        await syncPendingRequests(h.id)
        assert.deepEqual(candidates, [host, native], "known permissions retain their native recovery candidate until authoritative coverage settles them")
        assert.deepEqual(getPermissionQueue(h.id).map((entry) => entry.id), ["orphan-alias"])
        assert.deepEqual(getFormQueue(h.id).map((entry) => entry.id), ["orphan-alias"])
        assert.deepEqual(h.calls, [])
      } finally { h.cleanup() }
    }
  } finally { sdkManager.createClient = originalClient }
})

test("long escaped directory candidates are batched below the GET query budget without dropping candidates", async () => {
  const h = harness()
  try {
    const directories = Array.from({ length: 10 }, (_, index) => `/directory-${index}/${"a b".repeat(350)}`)
    setSessions(new Map([[h.id, new Map(directories.map((directory, index) => {
      const session = createClientSession({ id: `long-${index}`, title: "Long", location: { directory }, time: { created: 1, updated: 1 } } as any, h.id)
      return [session.id, session]
    }))]]))
    const batches: string[][] = []
    serverApi.getPendingRequests = async (_id, batch) => {
      batches.push(batch)
      return { supported: true, directories: batch.map((directory) => ({ directory, status: "ok", locations: [emptyLocation(directory)] })) }
    }
    await syncPendingRequests(h.id)
    assert.ok(batches.length > 1)
    assert.deepEqual(batches.flat(), [h.directory, ...directories])
    assert.ok(batches.every((batch) => new URLSearchParams(batch.map((directory) => ["directories", directory])).toString().length <= 7000))
    assert.deepEqual(h.calls, [])
  } finally { h.cleanup() }
})

test("permission mutations do not discard authoritative Forms; settlement tombstones survive bounded snapshots", async () => {
  const h = harness()
  try {
    let reads = 0
    const pending = deferred<WorkspacePendingRequestsResponse>()
    serverApi.getPendingRequests = async () => {
      if (++reads === 1) return pending.promise
      // The first pass's Forms must already be visible before a permission retry.
      assert.ok(getFormQueue(h.id).some((entry) => entry.id === "external"))
      return snapshot(h.directory, [], [form("external")])
    }
    const syncing = syncPendingRequests(h.id)
    await Promise.resolve()
    addPermissionToQueue(h.id, permission("live"), h.directory)
    pending.resolve(snapshot(h.directory, [], [form("external")]))
    await syncing
    assert.equal(reads, 2)
    markFormSettled(h.id, "settled")
    markPermissionReplied(h.id, "replied")
    serverApi.getPendingRequests = async () => snapshot(h.directory)
    await syncPendingRequests(h.id)
    serverApi.getPendingRequests = async () => snapshot(h.directory, [permission("replied")], [form("settled")])
    await syncPendingRequests(h.id)
    assert.deepEqual(getFormQueue(h.id), [])
    assert.deepEqual(getPermissionQueue(h.id), [])
  } finally { h.cleanup() }
})

test("rejected placement coverage upserts owned pending requests without pruning existing queues", async () => {
  const h = harness()
  try {
    addPermissionToQueue(h.id, permission("existing"), h.directory)
    addPendingForm(h.id, form("existing"), h.directory)
    serverApi.getPendingRequests = async () => ({ supported: true, directories: [{ directory: h.directory, status: "error", locations: [{
      location: { directory: h.directory }, permissions: [permission("external")], forms: [form("external")],
    }] }] })
    await assert.rejects(syncPendingRequests(h.id))
    assert.deepEqual(getPermissionQueue(h.id).map((entry) => entry.id), ["existing", "external"])
    assert.deepEqual(getFormQueue(h.id).map((entry) => entry.id), ["existing", "external"])
  } finally { h.cleanup() }
})

test("Form mutations do not discard authoritative permissions from the same snapshot", async () => {
  const h = harness()
  try {
    let reads = 0
    const pending = deferred<WorkspacePendingRequestsResponse>()
    serverApi.getPendingRequests = async () => {
      if (++reads === 1) return pending.promise
      assert.ok(getPermissionQueue(h.id).some((entry) => entry.id === "external"))
      return snapshot(h.directory, [permission("external")])
    }
    const syncing = syncPendingRequests(h.id)
    await Promise.resolve()
    addPendingForm(h.id, form("live"), h.directory)
    pending.resolve(snapshot(h.directory, [permission("external")]))
    await syncing
    assert.equal(reads, 2)
  } finally { h.cleanup() }
})

test("a failed later batch preserves its queues while applying earlier complete coverage", async () => {
  const h = harness()
  try {
    setSessions(new Map([[h.id, new Map(Array.from({ length: 70 }, (_, index) => {
      const session = createClientSession({ id: `cold-${index}`, title: "Cold", location: { directory: `/cold-${index}` }, time: { created: 1, updated: 1 } } as any, h.id)
      return [session.id, session]
    }))]]))
    addPendingForm(h.id, { ...form("later"), location: { directory: "/cold-69" } })
    let reads = 0
    serverApi.getPendingRequests = async () => {
      if (++reads === 2) throw new Error("second batch unavailable")
      return snapshot(h.directory, [], [form("external")])
    }
    await assert.rejects(syncPendingRequests(h.id))
    assert.deepEqual(getFormQueue(h.id).map((entry) => entry.id), ["later", "external"])
    assert.deepEqual(h.calls, [])
  } finally { h.cleanup() }
})

test("complete empty pending coverage never implies a working session is idle", async () => {
  const h = harness()
  try {
    const session = createClientSession({ id: "background", title: "Working", location: { directory: h.directory }, time: { created: 1, updated: 1 } } as any, h.id, "", undefined, "working")
    setSessions(new Map([[h.id, new Map([[session.id, session]])]]))
    addPermissionToQueue(h.id, permission("gone"), h.directory)
    serverApi.getPendingRequests = async () => snapshot(h.directory)
    await syncPendingRequests(h.id)
    assert.equal(sessions().get(h.id)?.get(session.id)?.status, "working")
    assert.equal(sessions().get(h.id)?.get(session.id)?.pendingPermission, false)
  } finally { h.cleanup() }
})

test("late snapshots cannot publish after removal, invalidation or client replacement", async () => {
  for (const unsupported of [false, true]) for (const invalidate of ["remove", "reconnect", "client"] as const) {
    const h = harness()
    try {
      let reads = 0
      const pending = deferred<WorkspacePendingRequestsResponse>()
      serverApi.getPendingRequests = async () => ++reads === 1 ? pending.promise : snapshot(h.directory)
      const syncing = syncPendingRequests(h.id)
      await Promise.resolve()
      if (invalidate === "remove") removeInstance(h.id, { authoritative: false })
      if (invalidate === "reconnect") invalidatePendingRequestSync(h.id)
      if (invalidate === "client") updateInstance(h.id, { client: { ...h.client } as OpenCodeClient })
      pending.resolve(unsupported ? { supported: false } : snapshot(h.directory, [permission("late")], [form("late")]))
      await syncing
      assert.deepEqual(getPermissionQueue(h.id), [])
      assert.deepEqual(getFormQueue(h.id), [])
    } finally { h.cleanup() }
  }
})

test("unsupported and failed snapshots retain queues without loading cold worktrees, then reconnect recovers active/global requests", async () => {
  const h = harness()
  const originalWorktrees = serverApi.fetchWorktrees
  try {
    serverApi.fetchWorktrees = async () => ({ worktrees: Array.from({ length: 100 }, (_, index) => ({
      slug: `cold-${index}`, directory: `/cold-${index}`, kind: "worktree" as const,
    })) })
    await reloadWorktrees(h.id)
    addPendingForm(h.id, { ...form("background"), location: { directory: "/background" } })
    addPermissionToQueue(h.id, permission("background"), "/background")
    serverApi.getPendingRequests = async () => { throw new Error("snapshot unavailable") }
    await assert.rejects(syncPendingRequests(h.id))
    assert.equal(getFormQueue(h.id).length, 1)
    assert.equal(incompletePendingRecovery().has(h.id), true)
    assert.deepEqual(h.calls, [])
    serverApi.getPendingRequests = async () => ({} as WorkspacePendingRequestsResponse)
    await assert.rejects(syncPendingRequests(h.id))
    assert.equal(getFormQueue(h.id).length, 1)
    assert.deepEqual(h.calls, [])
    serverApi.getPendingRequests = async () => ({ supported: false })
    await assert.rejects(syncPendingRequests(h.id))
    assert.deepEqual(h.calls, [])
    assert.deepEqual(getFormQueue(h.id).map((entry) => entry.id), ["background"])
    assert.deepEqual(getPermissionQueue(h.id).map((entry) => entry.id), ["background"])
    clearReloadableInstanceState(h.id)
    assert.deepEqual(getFormQueue(h.id).map((entry) => entry.id), ["background"])
    assert.deepEqual(getPermissionQueue(h.id).map((entry) => entry.id), ["background"])
    assert.equal(incompletePendingRecovery().has(h.id), true)
    invalidatePendingRequestSync(h.id)
    updateInstance(h.id, { client: { ...h.client } as OpenCodeClient })
    serverApi.getPendingRequests = async (_id, directories) => ({ supported: true, directories: directories.map((directory) => ({
      directory, status: "ok" as const, locations: [{ location: { directory },
        permissions: directory === h.directory ? [permission("active")] : directory === "/background" ? [permission("background")] : [],
        forms: directory === h.directory ? [form("global")] : directory === "/background" ? [form("background")] : [],
      }],
    })) })
    await syncPendingRequests(h.id)
    assert.equal(incompletePendingRecovery().has(h.id), false)
    assert.deepEqual(h.calls, [])
    assert.deepEqual(getPermissionQueue(h.id).map((entry) => entry.id), ["background", "active"])
    assert.deepEqual(getFormQueue(h.id).map((entry) => entry.id), ["background", "global"])
    assert.equal(getFormQueue(h.id).find((entry) => entry.id === "global")?.location?.directory, h.directory)
  } finally { serverApi.fetchWorktrees = originalWorktrees; h.cleanup(); assert.equal(incompletePendingRecovery().has(h.id), false) }
})

test("ambiguous global Form reply is not replayed and recovery keeps location authority", async () => {
  const h = harness()
  const originalClient = sdkManager.createClient
  try {
    let replies = 0
    const recovered = deferred<void>()
    let readStarted!: () => void
    const started = new Promise<void>((resolve) => { readStarted = resolve })
    sdkManager.createClient = () => ({ session: { form: { reply: async (_input: unknown, options: any) => {
      replies++
      assert.equal(options.headers["x-opencode-directory"], encodeURIComponent(h.directory))
      throw new Error("ambiguous")
    } } } }) as unknown as OpenCodeClient
    h.client.form.list = async (input) => {
      const location = input!.location!
      readStarted(); await recovered.promise
      return { location: { directory: location!.directory! }, data: [form("global")] }
    }
    serverApi.getPendingRequests = async () => snapshot(h.directory, [], [form("global")])
    addPendingForm(h.id, { ...form("global"), location: { directory: h.directory } })
    await assert.rejects(sendFormReply(h.id, "global", { answer: "yes" }))
    await started
    recovered.resolve()
    await syncPendingRequests(h.id)
    assert.equal(replies, 1)
    assert.equal(getFormQueue(h.id)[0]?.location?.directory, h.directory)
  } finally { sdkManager.createClient = originalClient; h.cleanup() }
})
