import assert from "node:assert/strict"
import { test } from "node:test"
import type { OpenCodeClient, PermissionRequest } from "@opencode/client"
import type { WorkspacePendingRequestsResponse } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { sdkManager } from "../lib/sdk-manager"
import {
  addInstance, removeInstance, updateInstance, syncPendingRequests, invalidatePendingRequestSync,
  addPermissionToQueue, getPermissionQueue, markPermissionReplied,
  addPendingForm, sendFormReply,
} from "./instances"
import { getFormQueue, type FormWithLocation } from "./forms"
import { markFormSettled } from "./form-settlements"
import { sessions, setSessions } from "./session-state"
import { createClientSession } from "../types/session"
import { reloadWorktrees } from "./worktrees"
import { sseManager } from "../lib/sse-manager"

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

test("one supported snapshot avoids all ordinary pending lists with 100 cold historical and 100 worktree locations", async () => {
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
    assert.equal(calls, 4)
    assert.deepEqual(batches.map((batch) => batch.length), [64, 64, 64, 9])
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
        assert.deepEqual(candidates, [host])
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
  for (const invalidate of ["remove", "reconnect", "client"] as const) {
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
      pending.resolve(snapshot(h.directory, [permission("late")], [form("late")]))
      await syncing
      assert.deepEqual(getPermissionQueue(h.id), [])
      assert.deepEqual(getFormQueue(h.id), [])
    } finally { h.cleanup() }
  }
})

test("unsupported retains original discovery scans, while snapshot failures never silently clear queues", async () => {
  const h = harness()
  try {
    addPendingForm(h.id, { ...form("background"), location: { directory: "/background" } })
    serverApi.getPendingRequests = async () => { throw new Error("snapshot unavailable") }
    await assert.rejects(syncPendingRequests(h.id))
    assert.equal(getFormQueue(h.id).length, 1)
    assert.deepEqual(h.calls, [])
    serverApi.getPendingRequests = async () => ({} as WorkspacePendingRequestsResponse)
    await assert.rejects(syncPendingRequests(h.id))
    assert.equal(getFormQueue(h.id).length, 1)
    assert.deepEqual(h.calls, [])
    serverApi.getPendingRequests = async () => ({ supported: false })
    await syncPendingRequests(h.id)
    assert.ok((h.calls as string[]).includes("form:/background"))
    assert.ok((h.calls as string[]).includes(`permission:${h.directory}`))
  } finally { h.cleanup() }
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
