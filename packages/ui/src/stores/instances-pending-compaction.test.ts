import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"
import type { OpenCodeClient, PermissionRequest, SessionActiveOutput } from "@opencode/client"
import { serverApi } from "../lib/api-client"
import { sdkManager } from "../lib/sdk-manager"
import { sseManager } from "../lib/sse-manager"
import {
  addInstance, removeInstance, updateInstance, syncPendingRequests, reconcilePendingRequestLiveness,
  addPermissionToQueue, getPermissionQueue, markPermissionReplied, hasRepliedPermission, sendPermissionResponse,
  addPendingForm, sendFormReply, sendFormCancel,
} from "./instances"
import { getFormQueue, type FormWithLocation } from "./forms"
import { markFormSettled, hasSettledForm } from "./form-settlements"
import { sessions, setSessions } from "./session-state"
import { createClientSession } from "../types/session"
import { reloadWorktrees } from "./worktrees"
import toast from "solid-toast"

const permission = (id: string): PermissionRequest => ({ id, sessionID: "unloaded", action: "read", resources: ["file"] })
const form = (id: string, sessionID = "global"): FormWithLocation => ({
  id, sessionID, title: "Question", fields: [{ key: "answer", type: "string", title: "Answer" }],
})
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
async function until(check: () => boolean) {
  for (let i = 0; i < 1000 && !check(); i++) await new Promise<void>((done) => setImmediate(done))
  assert.ok(check(), "fixture did not settle")
  await new Promise<void>((done) => setImmediate(done))
}
const originalPending = serverApi.getPendingRequests, originalWorktrees = serverApi.fetchWorktrees
const originalClient = sdkManager.createClient
const originalToast = toast.custom
let sequence = 0, brokerReads = 0
const fixtures: ReturnType<typeof harness>[] = []
beforeEach(() => {
  toast.custom = () => "fixture-toast"
  brokerReads = 0
  serverApi.getPendingRequests = async () => { brokerReads++; return { supported: false } }
  sdkManager.createClient = (id) => fixtures.find((h) => h.id === id)!.client
})
afterEach(() => {
  toast.custom = originalToast
  for (const h of fixtures.splice(0)) {
    removeInstance(h.id, { authoritative: false })
    setSessions((previous) => { const next = new Map(previous); next.delete(h.id); return next })
  }
  serverApi.getPendingRequests = originalPending
  serverApi.fetchWorktrees = originalWorktrees
  sdkManager.createClient = originalClient
})
function harness(): {
  id: string; directory: string; reads: string[]; client: OpenCodeClient;
  permissions: PermissionRequest[]; forms: FormWithLocation[]; active: SessionActiveOutput;
  mutations: number; ambiguous: boolean; clock: number
} {
  const id = `compaction-fixture-${++sequence}`, directory = `/compaction-${sequence}`
  const reads: string[] = []
  const h = {
    id, directory, reads, client: undefined as unknown as OpenCodeClient,
    permissions: [] as PermissionRequest[], forms: [] as FormWithLocation[], active: {} as SessionActiveOutput,
    mutations: 0, ambiguous: false, clock: 100,
  }
  const mutate = async () => { h.mutations++; if (h.ambiguous) throw new Error("ambiguous response") }
  h.client = {
    permission: { reply: mutate, request: { list: async ({ location }: any) => {
      reads.push(`permission:${location.directory}`)
      return { location, data: location.directory === directory ? h.permissions : [] }
    } } },
    form: { list: async ({ location }: any) => {
      reads.push(`form:${location.directory}`)
      return { location, data: location.directory === directory ? h.forms : [] }
    } },
    session: { active: async () => h.active, get: async () => { throw new Error("not in the loaded page") },
      form: { reply: mutate, cancel: mutate } },
  } as unknown as OpenCodeClient
  addInstance({ id, folder: directory, port: 0, pid: 0, proxyPath: "", status: "ready", client: h.client })
  fixtures.push(h)
  return h
}
function compact(h: ReturnType<typeof harness>, phase: "started" | "delta" | "ended" | "failed", sessionID = "unknown-child", seq = ++h.clock) {
  sseManager["handleEvent"](h.id, {
    id: `event-${seq}`, created: seq, type: `session.compaction.${phase}`,
    ...(phase === "delta" ? {} : { durable: { aggregateID: sessionID, seq, version: 1 } }),
    location: { directory: h.directory },
    data: { sessionID, reason: "auto", recent: "recent", text: "summary", error: { _tag: "UnknownError", message: "fixture" } },
  } as any)
}
async function history(h: ReturnType<typeof harness>) {
  serverApi.fetchWorktrees = async () => ({ worktrees: Array.from({ length: 100 }, (_, i) => ({
    slug: `tree-${i}`, directory: `${h.directory}/tree-${i}`, kind: "worktree" as const,
  })) })
  await reloadWorktrees(h.id)
  setSessions((previous) => new Map(previous).set(h.id, new Map(Array.from({ length: 100 }, (_, i) => {
    const session = createClientSession({ id: `cold-${i}`, title: "Cold", location: { directory: `${h.directory}/cold-${i}` }, time: { created: 1, updated: 1 } } as any, h.id)
    return [session.id, session]
  }))))
}

test("published-daemon scans defer across instances and recover idle/global Forms only after the last overlapping compaction", async () => {
  const a = harness(), b = harness()
  await history(b)
  compact(a, "started")
  compact(a, "started", "unknown-child", a.clock) // duplicate start
  compact(a, "delta")
  compact(b, "started", "other-child")
  assert.equal(sessions().get(a.id)?.size ?? 0, 0)
  sseManager["handleEvent"](b.id, { id: "live-permission", created: 200, type: "permission.asked", location: { directory: b.directory }, data: permission("live") })
  sseManager["handleEvent"](b.id, { id: "live-form", created: 201, type: "form.created", location: { directory: b.directory }, data: { form: form("live") } } as any)
  const draft = getFormQueue(b.id)[0]
  await Promise.all([syncPendingRequests(a.id), syncPendingRequests(b.id), syncPendingRequests(b.id)])
  assert.equal(brokerReads, 0)
  assert.deepEqual([...a.reads, ...b.reads], [])
  assert.equal(getFormQueue(b.id)[0], draft)
  await sendPermissionResponse(b.id, "ignored", "live", "once")
  await sendFormCancel(b.id, "live")
  assert.equal(b.mutations, 2)
  assert.deepEqual(b.reads, [])
  b.forms = [form("missed-global"), form("missed-ordinary", "cold-99")]
  b.permissions = [permission("missed-idle")]
  compact(a, "ended")
  compact(a, "delta", "unknown-child", a.clock - 1) // stale delta cannot re-open it
  await syncPendingRequests(b.id)
  assert.equal(brokerReads, 0)
  compact(b, "failed", "other-child")
  await until(() => a.reads.length === 2 && b.reads.length === 402)
  assert.equal(brokerReads, 2, "one trailing scan per deferred instance, not per event")
  assert.deepEqual(getPermissionQueue(b.id).map((p) => p.id), ["missed-idle"])
  assert.deepEqual(getFormQueue(b.id).map((f) => f.id), ["missed-global", "missed-ordinary"])
})

test("a compaction beginning mid legacy scan stops queued admissions and preserves every unscanned queue", async () => {
  const h = harness()
  await history(h)
  addPermissionToQueue(h.id, permission("unscanned"), `${h.directory}/cold-99`)
  addPendingForm(h.id, { ...form("unscanned"), location: { directory: `${h.directory}/cold-99` } })
  const held = deferred<void>()
  const listPermissions = h.client.permission.request.list, listForms = h.client.form.list
  h.client.permission.request.list = async (...args) => { const result = await listPermissions(...args); await held.promise; return result }
  h.client.form.list = async (...args) => { const result = await listForms(...args); await held.promise; return result }
  const syncing = syncPendingRequests(h.id)
  await until(() => h.reads.length === 2)
  compact(h, "started")
  held.resolve()
  await syncing
  assert.equal(h.reads.length, 2)
  assert.equal(getPermissionQueue(h.id)[0]?.id, "unscanned")
  assert.equal(getFormQueue(h.id)[0]?.id, "unscanned")
  await syncPendingRequests(h.id)
  assert.equal(brokerReads, 1)
  compact(h, "ended")
  await until(() => h.reads.length === 404)
  assert.deepEqual(getPermissionQueue(h.id), [])
  assert.deepEqual(getFormQueue(h.id), [])
})

test("supported snapshot batching also stops before the next batch during compaction", async () => {
  const h = harness()
  await history(h)
  addPendingForm(h.id, { ...form("unscanned"), location: { directory: `${h.directory}/cold-99` } })
  let batches = 0
  serverApi.getPendingRequests = async (_id, directories) => {
    if (++batches === 1) compact(h, "started")
    return { supported: true, directories: directories.map((directory) => ({ directory, status: "ok", locations: [{ location: { directory }, permissions: [], forms: [] }] })) }
  }
  await syncPendingRequests(h.id)
  assert.equal(batches, 1)
  assert.equal(getFormQueue(h.id)[0]?.id, "unscanned")
  compact(h, "ended")
  await until(() => batches === 27)
  assert.deepEqual(h.reads, [])
  assert.deepEqual(getFormQueue(h.id), [])
})

test("liveness handles a missed end for an unloaded child, but an active or newly updated compaction keeps the hold", async () => {
  const a = harness(), b = harness()
  compact(a, "delta") // missed start, no transcript/session loaded
  await syncPendingRequests(b.id)
  a.active = { "unknown-child": { type: "running" } }
  await reconcilePendingRequestLiveness(a.id)
  assert.equal(brokerReads, 0)
  const active = deferred<SessionActiveOutput>()
  a.client.session.active = () => active.promise
  const polling = reconcilePendingRequestLiveness(a.id)
  compact(a, "delta")
  active.resolve({})
  await polling
  assert.equal(brokerReads, 0, "a stale status read cannot settle a newer delta")
  a.client.session.active = async () => ({})
  await reconcilePendingRequestLiveness(a.id)
  await until(() => a.reads.length === 2 && b.reads.length === 2)
  assert.equal(brokerReads, 2)
})

test("disconnect/client replacement fence old ends; removal cannot revive a removed instance", async () => {
  const a = harness(), b = harness()
  compact(a, "started")
  await syncPendingRequests(a.id)
  await syncPendingRequests(b.id)
  sseManager.onConnectionLost?.(a.id, "fixture disconnected")
  updateInstance(a.id, { client: { ...a.client } as OpenCodeClient })
  compact(a, "ended") // previous client's start is not settled by this event
  await syncPendingRequests(b.id)
  assert.equal(brokerReads, 0)
  await reconcilePendingRequestLiveness(a.id)
  await until(() => b.reads.length === 2)
  assert.equal(a.reads.length, 2, "explicit liveness, not the invalidated deferred scan, recovers this instance")
  const reads = brokerReads
  compact(a, "started")
  await syncPendingRequests(a.id)
  removeInstance(a.id, { authoritative: false })
  compact(a, "ended")
  await new Promise<void>((done) => setImmediate(done))
  assert.equal(brokerReads, reads)
})

test("ambiguous permission/Form replies and cancellation reconcile only known authority without replay or tombstone loss", async () => {
  const a = harness(), b = harness()
  await history(b)
  compact(a, "started")
  b.ambiguous = true
  markPermissionReplied(b.id, "elsewhere-permission")
  markFormSettled(b.id, "elsewhere-form")
  addPermissionToQueue(b.id, permission("ambiguous"), b.directory)
  addPendingForm(b.id, { ...form("ambiguous-global"), location: { directory: b.directory } })
  addPendingForm(b.id, form("ambiguous-ordinary", "unloaded"), b.directory)
  b.permissions = [permission("ambiguous")]
  b.forms = [form("ambiguous-global"), form("ambiguous-ordinary", "unloaded")]
  await assert.rejects(sendPermissionResponse(b.id, "ignored", "ambiguous", "once"))
  await until(() => b.reads.length === 2)
  await assert.rejects(sendFormReply(b.id, "ambiguous-global", { answer: "yes" }))
  await until(() => b.reads.length === 4)
  await assert.rejects(sendFormCancel(b.id, "ambiguous-ordinary"))
  await until(() => b.reads.length === 6)
  assert.equal(b.mutations, 3)
  assert.equal(brokerReads, 0)
  assert.ok(b.reads.every((read) => read.endsWith(`:${b.directory}`)))
  assert.equal(getPermissionQueue(b.id)[0]?.id, "ambiguous")
  assert.equal(getFormQueue(b.id).length, 2)
  assert.equal(hasRepliedPermission(b.id, "elsewhere-permission"), true)
  assert.equal(hasSettledForm(b.id, "elsewhere-form"), true)
})
