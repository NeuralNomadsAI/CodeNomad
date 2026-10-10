import assert from "node:assert/strict"
import { test } from "node:test"
import type { OpenCodeClient, PermissionRequest } from "@opencode/client"
import type { WorkspacePendingRequestsResponse } from "../../../server/src/api-types"
import { PENDING_REQUEST_SNAPSHOT_TIMEOUT_MS } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { sdkManager } from "../lib/sdk-manager"
import {
  addInstance, removeInstance, updateInstance, syncPendingRequests, invalidatePendingRequestSync,
  addPermissionToQueue, getPermissionQueue, markPermissionReplied,
  addPendingForm, sendFormReply,
  incompletePendingRecovery, clearReloadableInstanceState,
} from "./instances"
import { getFormQueue, type FormWithLocation } from "./forms"
import { markFormSettled } from "./form-settlements"
import { sessions, setSessions } from "./session-state"
import { createClientSession } from "../types/session"
import { reloadWorktrees } from "./worktrees"
import { sseManager } from "../lib/sse-manager"
import { getToastHistory } from "../lib/notifications"
import { tGlobal } from "../lib/i18n"

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

test("obsolete history can be excluded while valid idle subdirectories still recover questions and permissions", async () => {
  const h = harness()
  try {
    const deleted = "/deleted-temporary-history", subdirectory = `${h.directory}/idle-subdirectory`
    setSessions((previous) => new Map(previous).set(h.id, new Map([deleted, subdirectory].map((directory, index) => {
      const session = createClientSession({ id: `history-${index}`, title: "History", location: { directory }, time: { created: 1, updated: 1 } } as any, h.id)
      return [session.id, session]
    }))))
    serverApi.getPendingRequests = async (_id, directories, _signal, optional) => {
      assert.deepEqual(optional, [deleted, subdirectory])
      return { supported: true, directories: directories.map((directory) => directory === deleted
        ? { directory, status: "excluded" as const }
        : { directory, status: "ok" as const, locations: [{ location: { directory },
          permissions: directory === subdirectory ? [permission("idle")] : [], forms: directory === subdirectory ? [form("idle")] : [],
        }] }) }
    }
    await syncPendingRequests(h.id)
    assert.equal(incompletePendingRecovery().has(h.id), false)
    assert.deepEqual(getPermissionQueue(h.id).map((request) => request.id), ["idle"])
    assert.deepEqual(getFormQueue(h.id).map((request) => request.id), ["idle"])
    assert.equal(sessions().get(h.id)?.size, 2, "excluding a recovery hint never deletes its historical session")
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

test("the recovery warning needs consecutive incomplete attempts and a success re-arms it", async () => {
  const h = harness()
  const warnings = () => getToastHistory().filter((item) => item.message === tGlobal("interruption.recoveryIncomplete")).length
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
        await syncPendingRequests(h.id)
        assert.equal(getPermissionQueue(h.id).length, 2, "an outer UI alias is not native coverage")
        assert.equal(getFormQueue(h.id).length, 3, "empty placement provenance cannot clear Forms")
        serverApi.getPendingRequests = async (_id, directories) => {
          candidates = directories
          return { supported: true, directories: [{ directory: host, status: "ok", locations: [emptyLocation(native)] }] }
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
    serverApi.getPendingRequests = async () => snapshot(h.directory, [permission("active")], [form("global")])
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
