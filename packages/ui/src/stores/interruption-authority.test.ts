import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"
import { OpenCode, type OpenCodeClient } from "@opencode/client"
import toast from "solid-toast"
import { initialServerCapabilities } from "../../../server/src/opencode/servers/capabilities"
import { sdkManager } from "../lib/sdk-manager"
import { serverApi } from "../lib/api-client"
import { serverEvents } from "../lib/server-events"
import { getToastHistory } from "../lib/notifications"
import { HttpResponseError } from "../lib/retryable-file-search"
import { getLogger } from "../lib/logger"
import { addInstance, updateInstance, removeInstance, instances, getPermissionQueue, sendPermissionResponse,
  addPendingForm, sendFormReply, sendFormCancel, incompletePendingRecovery, syncPendingRequests, hasRepliedPermission, trackWorkspaceClose } from "./instances"
import { getFormQueue } from "./forms"
import { hasSettledForm, clearSettledForms } from "./form-settlements"
import { canAnswerInterruption } from "./interruption-authority"
import { getInterruptionQueue } from "./interruption-scope"
import { setSessions } from "./session-state"

const originalClient = sdkManager.createClient, originalPending = serverApi.getPendingRequests
const originalToast = toast.custom
type Owner = { id: string; server: string; directory: string; calls: { path: string; body?: unknown; headers: Record<string, string> }[];
  client: OpenCodeClient; hold?: ReturnType<typeof deferred>; fail: boolean; sourceGeneration: number; nativeGeneration: number;
  contexts: Map<number, { source: { serverId: string; generation: number; connectionGeneration: number }; liveGeneration: number }> }
const owners: Owner[] = []
let sequence = 0, clock = 10, recoveryReads = 0, screenNotices = 0, sourceGeneration = 100, liveGeneration = 10000
const deferred = () => {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
beforeEach(() => {
  screenNotices = 0
  toast.custom = () => { screenNotices++; return "owned-toast" }
  sdkManager.createClient = id => owners.find(owner => owner.id === id)!.client
  recoveryReads = 0
  serverApi.getPendingRequests = async () => { recoveryReads++; throw new Error("Forbidden pending recovery") }
})
afterEach(() => {
  for (const item of owners.splice(0)) {
    removeInstance(item.id, { authoritative: false })
    setSessions(previous => { const next = new Map(previous); next.delete(item.id); return next })
  }
  sdkManager.createClient = originalClient
  serverApi.getPendingRequests = originalPending
  toast.custom = originalToast
})
function owner(server = "A", directory = "/工作/100% ready"): Owner {
  const id = `live-authority-${++sequence}`
  const calls: { path: string; body?: unknown; headers: Record<string, string> }[] = []
  const item = { id, server, directory, calls, client: undefined as unknown as OpenCodeClient, sourceGeneration: ++sourceGeneration,
    hold: undefined as ReturnType<typeof deferred> | undefined, fail: false, nativeGeneration: 1, contexts: new Map() }
  item.client = OpenCode.make({ baseUrl: `http://127.0.0.1/${id}`, fetch: async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname
    if (!/\/api\/session\/same-session\/(permission\/same-permission\/reply|form\/same-form(?:\/reply)?)$/.test(path)
      && !/\/api\/session\/global\/form\/same-form(?:\/reply)?$/.test(path)) throw new Error(`Forbidden SDK read: ${path}`)
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: Object.fromEntries(new Headers(init?.headers)) })
    await item.hold?.promise
    if (item.fail) throw new TypeError("Owned transport failure")
    return new Response(null, { status: 204 })
  } })
  owners.push(item)
  const capabilities = initialServerCapabilities({ id: server, kind: "explicit", label: server, origin: "https://example.invalid" }, 1)
  for (const capability of ["permissions", "questions", "events"] as const) capabilities.features[capability] = { state: "available", reason: { code: "contractVerified" }, evidence: "nativeContract" }
  addInstance({ id, folder: directory, binding: { serverId: server, directory }, capabilities, client: item.client,
    proxyPath: `/workspaces/${id}/instance`, status: "ready", port: 0, pid: 0 }, serverEvents.captureTransportAuthority())
  setSessions(previous => new Map(previous).set(id, new Map([["same-session", { id: "same-session", instanceId: id,
    location: { directory }, parentId: null, title: "Same title", status: "idle", time: { created: 1, updated: 1 } } as any]])))
  status(item, "connected")
  return item
}
function status(item: ReturnType<typeof owner>, status: string, generation = item.sourceGeneration) {
  item.sourceGeneration = generation
  const context = status === "connected" && item.contexts.get(generation) || {
    source: { serverId: item.server, generation, connectionGeneration: item.nativeGeneration }, liveGeneration: ++liveGeneration,
  }
  if (status === "connected") item.contexts.set(generation, context)
  ;(serverEvents as any).dispatchBatch([{ type: "instance.eventStatus", instanceId: item.id, status,
    ...context }])
}
function emit(item: ReturnType<typeof owner>, type: string, data: unknown, sessionID = "same-session", generation = item.sourceGeneration) {
  ;(serverEvents as any).dispatchBatch([{ type: "instance.event", instanceId: item.id, ...item.contexts.get(generation),
    event: { id: `owned-${++clock}`, created: clock, type, location: { directory: item.directory }, data: { sessionID, ...data as object } } }])
}
function ask(item: ReturnType<typeof owner>, kind: "permission" | "form", global = false) {
  if (kind === "permission") emit(item, "permission.asked", { id: "same-permission", action: "read", resources: ["owned"] })
  else emit(item, "form.created", { form: { id: "same-form", sessionID: global ? "global" : "same-session", title: "Same question", metadata: { kind: "question" },
    fields: [{ key: "answer", type: "string" }], state: { status: "pending" } } }, global ? "global" : "same-session")
}
const request = (item: ReturnType<typeof owner>, kind: "permission" | "form") => kind === "permission" ? getPermissionQueue(item.id)[0] : getFormQueue(item.id)[0]

test("local + A + B homonyms use captured official clients; global Unicode/% directory is encoded once, explicit never sends the human hint", async () => {
  const local = owner("local-shared"), a = owner(), b = owner("B")
  for (const item of [local, a, b]) {
    ask(item, "permission")
    await assert.rejects(sendPermissionResponse(item.id, "wrong-session", "same-permission", "once"))
    assert.equal(item.calls.length, 0)
    await sendPermissionResponse(item.id, "same-session", "same-permission", "reject", "synthetic")
    ask(item, "form", true)
    await sendFormReply(item.id, "same-form", { answer: "synthetic" })
    clearSettledForms(item.id) // This synthetic fixture deliberately reuses a native Form ID.
    ask(item, "form", true)
    await sendFormCancel(item.id, "same-form")
    assert.equal(item.calls.length, 3)
    assert(item.calls.every(call => call.path.startsWith(`/${item.id}/`)))
    for (const call of item.calls.slice(1)) {
      assert.equal(call.headers["x-opencode-directory"], encodeURIComponent(item.directory))
      assert.equal(call.headers["x-codenomad-human-answer"], undefined)
      assert.equal(call.headers["x-codenomad-location"], undefined)
    }
  }
  assert.equal(recoveryReads, 0)
})

for (const action of ["permission", "reply", "cancel"] as const) test(`${action}: rotation during await cannot settle the replacement homonym or replay`, async () => {
  const a = owner(), b = owner("B")
  const kind = action === "permission" ? "permission" : "form"
  ask(a, kind); ask(b, kind)
  a.hold = deferred()
  const sending = action === "permission" ? sendPermissionResponse(a.id, "same-session", "same-permission", "once")
    : action === "reply" ? sendFormReply(a.id, "same-form", { answer: "synthetic" }) : sendFormCancel(a.id, "same-form")
  const rejection = assert.rejects(sending, /may have reached OpenCode/)
  a.nativeGeneration = 2
  updateInstance(a.id, { capabilities: { ...instances().get(a.id)!.capabilities!, generation: 2 } }, serverEvents.captureTransportAuthority())
  status(a, "connected", ++sourceGeneration)
  ask(a, kind)
  const replacement = request(a, kind), other = request(b, kind)
  a.hold.resolve()
  await rejection
  assert.equal(request(a, kind), replacement)
  assert.equal(request(b, kind), other)
  assert.equal(hasRepliedPermission(a.id, "same-permission"), false)
  assert.equal(hasSettledForm(a.id, "same-form"), false)
  assert.equal(a.calls.length, 1)
  assert.equal(b.calls.length, 0)
  assert.equal(recoveryReads, 0)
})

test("backend disconnect/restart retains known editors, unknown empty coverage and no projects notification", async () => {
  const before = getToastHistory().length
  const directory = `/warning-${sequence}/工作/100% ready`
  const a = owner("A", directory), b = owner("B", directory), empty = owner("C", directory)
  ask(a, "form"); ask(a, "permission")
  const form = getFormQueue(a.id)[0], permission = getPermissionQueue(a.id)[0]
  assert(canAnswerInterruption(a.id, "form", form))
  for (let i = 0; i < 4; i++) status(a, "disconnected")
  ;(serverEvents as any).emitTransportStatus("disconnected")
  for (const item of [a, b, empty]) {
    assert.equal(incompletePendingRecovery().has(item.id), true)
    await syncPendingRequests(item.id)
  }
  assert.equal(getFormQueue(a.id)[0], form)
  assert.equal(canAnswerInterruption(a.id, "form", form), false)
  await assert.rejects(sendFormReply(a.id, form.id, { answer: "preserved" }))
  await assert.rejects(sendFormCancel(a.id, form.id))
  await assert.rejects(sendPermissionResponse(a.id, permission.sessionID, permission.id, "once"))
  status(a, "connected", ++sourceGeneration)
  assert.equal(canAnswerInterruption(a.id, "form", form), false, "connected never validates a retained request")
  updateInstance(a.id, { capabilities: { ...instances().get(a.id)!.capabilities!, generation: a.nativeGeneration } }, serverEvents.captureTransportAuthority())
  assert.equal(canAnswerInterruption(a.id, "form", form), false, "fresh metadata alone never re-admits an old queue entry")
  ask(a, "form")
  assert.equal(canAnswerInterruption(a.id, "form", getFormQueue(a.id)[0]), true)
  assert.equal(canAnswerInterruption(a.id, "permission", permission), false, "a Form cannot validate its sibling permission")
  for (const handler of (serverEvents as any).openHandlers) handler()
  assert.equal(canAnswerInterruption(a.id, "form", getFormQueue(a.id)[0]), false)
  // prototype-1236: unknown coverage stays a guard (replies refused above) without any notification.
  assert.equal(getToastHistory().length, before)
  assert.equal(screenNotices, 0)
  assert.equal(getInterruptionQueue(empty.id).length, 0, "unknown coverage creates no synthetic request")
  assert.equal(a.calls.length + b.calls.length + empty.calls.length, 0)
  assert.equal(recoveryReads, 0)
})

test("an ambiguous explicit failure retains request without settlement or even scheduling a pending reader", async () => {
  const a = owner()
  a.fail = true
  ask(a, "permission")
  await assert.rejects(sendPermissionResponse(a.id, "same-session", "same-permission", "once"))
  assert.equal(getPermissionQueue(a.id).length, 1)
  assert.equal(canAnswerInterruption(a.id, "permission", getPermissionQueue(a.id)[0]), false)
  await assert.rejects(sendPermissionResponse(a.id, "same-session", "same-permission", "once"))
  ask(a, "form", true)
  await assert.rejects(sendFormCancel(a.id, "same-form"))
  assert.equal(getFormQueue(a.id).length, 1)
  assert.equal(hasSettledForm(a.id, "same-form"), false)
  await syncPendingRequests(a.id, undefined, [{ directory: a.directory }])
  const capabilities = instances().get(a.id)!.capabilities!
  updateInstance(a.id, { capabilities: { ...capabilities, features: { ...capabilities.features,
    pendingRecovery: { state: "available", reason: { code: "contractVerified" }, evidence: "nativeContract" } } } }, serverEvents.captureTransportAuthority())
  await syncPendingRequests(a.id)
  assert.equal(a.calls.length, 2)
  assert.equal(recoveryReads, 0)
})

test("late errors and duplicate handler calls never affect a newer live request", async () => {
  const a = owner()
  ask(a, "form")
  a.hold = deferred()
  const first = sendFormReply(a.id, "same-form", { answer: "synthetic" })
  const rejected = assert.rejects(first)
  await assert.rejects(sendFormCancel(a.id, "same-form"))
  assert.equal(a.calls.length, 1)
  ask(a, "form")
  const newer = getFormQueue(a.id)[0]
  a.hold.reject(new Error("Owned late failure"))
  await rejected
  assert.equal(getFormQueue(a.id)[0], newer)
  assert.equal(canAnswerInterruption(a.id, "form", newer), true)
  assert.equal(recoveryReads, 0)
})

test("retained data alone and a foreign native workspace selector grant no explicit authority", async () => {
  const a = owner()
  addPendingForm(a.id, { id: "same-form", sessionID: "global", title: "Snapshot", fields: [], location: { directory: a.directory } } as any)
  await assert.rejects(sendFormReply(a.id, "same-form", {}))
  emit(a, "form.created", { form: { id: "same-form", sessionID: "global", title: "Foreign selector", fields: [] } }, "global")
  setSessions(previous => new Map(previous).set(a.id, new Map([["global", { id: "global", location: { directory: a.directory, workspaceID: "internal" } } as any]])))
  await assert.rejects(sendFormCancel(a.id, "same-form"))
  assert.equal(a.calls.length, 0)
})

for (const change of ["rebind", "client", "close-reuse"] as const) test(`a ${change} during a permission dispatch retires publication through the same shared guard`, async () => {
  const a = owner()
  ask(a, "permission")
  a.hold = deferred()
  const sending = sendPermissionResponse(a.id, "same-session", "same-permission", "once")
  const rejected = assert.rejects(sending, /may have reached OpenCode/)
  if (change === "rebind") updateInstance(a.id, { binding: { serverId: "other", directory: a.directory } })
  if (change === "client") updateInstance(a.id, { client: OpenCode.make({ baseUrl: "http://127.0.0.1:1", fetch: async () => { throw new Error("No new dispatch") } }) })
  if (change === "close-reuse") {
    const saved = instances().get(a.id)!
    removeInstance(a.id, { authoritative: false })
    addInstance({ ...saved })
  }
  a.hold.resolve()
  await rejected
  assert.equal(hasRepliedPermission(a.id, "same-permission"), false)
  assert.equal(a.calls.length, 1)
  assert.equal(recoveryReads, 0)
})

test("close intent retires responses synchronously, before its queued deletion begins", async () => {
  const a = owner(), closing = deferred()
  ask(a, "form")
  const close = trackWorkspaceClose(a.id, () => closing.promise)
  ask(a, "form")
  assert.equal(canAnswerInterruption(a.id, "form", getFormQueue(a.id)[0]), false)
  await assert.rejects(sendFormCancel(a.id, "same-form"))
  assert.equal(a.calls.length, 0)
  closing.resolve()
  await close
})

test("settlement events with another native session never remove or tombstone the current homonym", () => {
  const a = owner()
  ask(a, "permission"); ask(a, "form")
  const permission = getPermissionQueue(a.id)[0], form = getFormQueue(a.id)[0]
  emit(a, "permission.replied", { requestID: "same-permission", reply: "once" }, "other-session")
  emit(a, "form.replied", { id: "same-form", answer: {} }, "other-session")
  assert.equal(getPermissionQueue(a.id)[0], permission)
  assert.equal(getFormQueue(a.id)[0], form)
  assert.equal(hasRepliedPermission(a.id, "same-permission"), false)
  assert.equal(hasSettledForm(a.id, "same-form"), false)
})

test("a cold live request retains its native placement when its session is later loaded elsewhere", async () => {
  const a = owner()
  setSessions(previous => new Map(previous).set(a.id, new Map()))
  ask(a, "permission")
  assert.equal(canAnswerInterruption(a.id, "permission", getPermissionQueue(a.id)[0]), true)
  setSessions(previous => new Map(previous).set(a.id, new Map([["same-session", { id: "same-session", location: { directory: "/elsewhere" } } as any]])))
  await assert.rejects(sendPermissionResponse(a.id, "same-session", "same-permission", "once"))
  assert.equal(a.calls.length, 0)
})

test("relay and capability counters are independent: an old handshake cannot re-admit after metadata rotation", () => {
  const a = owner()
  assert.notEqual(a.sourceGeneration, instances().get(a.id)!.capabilities!.generation)
  a.nativeGeneration = 2
  updateInstance(a.id, { capabilities: { ...instances().get(a.id)!.capabilities!, generation: 2 } }, serverEvents.captureTransportAuthority())
  emit(a, "permission.replied", { requestID: "same-permission", reply: "once" })
  emit(a, "form.cancelled", { id: "same-form" })
  assert.equal(hasRepliedPermission(a.id, "same-permission"), false)
  assert.equal(hasSettledForm(a.id, "same-form"), false)
  ask(a, "form")
  assert.equal(canAnswerInterruption(a.id, "form", getFormQueue(a.id)[0]), false)
  status(a, "connected") // A replay of the old handshake is still stale.
  ask(a, "form")
  assert.equal(canAnswerInterruption(a.id, "form", getFormQueue(a.id)[0]), false)
  status(a, "connected", ++sourceGeneration)
  ask(a, "form")
  assert.equal(canAnswerInterruption(a.id, "form", getFormQueue(a.id)[0]), true)
})

test("rebinding clears only the old source's settlement tombstones before same-ID live requests", async () => {
  const a = owner()
  ask(a, "permission"); ask(a, "form")
  await sendPermissionResponse(a.id, "same-session", "same-permission", "once")
  await sendFormReply(a.id, "same-form", { answer: "synthetic A" })
  assert.equal(hasRepliedPermission(a.id, "same-permission"), true)
  assert.equal(hasSettledForm(a.id, "same-form"), true)
  updateInstance(a.id, { binding: { serverId: "B", directory: a.directory }, capabilities: { ...instances().get(a.id)!.capabilities!, serverId: "B" } }, serverEvents.captureTransportAuthority())
  a.server = "B"
  status(a, "connected", ++sourceGeneration)
  ask(a, "permission"); ask(a, "form")
  assert.equal(hasRepliedPermission(a.id, "same-permission"), false)
  assert.equal(hasSettledForm(a.id, "same-form"), false)
  assert.equal(canAnswerInterruption(a.id, "permission", getPermissionQueue(a.id)[0]), true)
  assert.equal(canAnswerInterruption(a.id, "form", getFormQueue(a.id)[0]), true)
})

test("a local settlement compares the entire legacy native Location", () => {
  const local = owner("local-shared"), location = { directory: local.directory, workspaceID: "legacy" }
  const publish = (type: string, data: any) => (serverEvents as any).dispatchBatch([{ type: "instance.event", instanceId: local.id,
    source: { serverId: local.server, generation: local.sourceGeneration }, event: { id: `legacy-${++clock}`, created: clock, type, location, data } }])
  publish("form.created", { form: { id: "same-form", sessionID: "global", title: "Legacy", fields: [], state: { status: "pending" } } })
  publish("permission.asked", { id: "same-permission", sessionID: "same-session", action: "read", resources: [] })
  publish("form.cancelled", { id: "same-form", sessionID: "global" })
  publish("permission.replied", { requestID: "same-permission", sessionID: "same-session", reply: "once" })
  assert.equal(getFormQueue(local.id).length, 0)
  assert.equal(getPermissionQueue(local.id).length, 0)
})

for (const gap of [false, true]) test(`definitive close refusal restores only its still-current admissions (intervening gap=${gap})`, async () => {
  const a = owner(), closing = deferred()
  ask(a, "form")
  const close = trackWorkspaceClose(a.id, () => closing.promise)
  const rejected = assert.rejects(close, error => error instanceof HttpResponseError && error.status === 409)
  assert.equal(canAnswerInterruption(a.id, "form", getFormQueue(a.id)[0]), false)
  if (gap) status(a, "disconnected")
  closing.reject(new HttpResponseError("Owned close refused", 409, null))
  await rejected
  assert.equal(canAnswerInterruption(a.id, "form", getFormQueue(a.id)[0]), !gap)
  assert.equal(a.calls.length, 0)
})

for (const generation of [undefined, 0, -1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) test(`invalid capability generation ${generation} never grants explicit actions`, async () => {
  const a = owner()
  updateInstance(a.id, { capabilities: { ...instances().get(a.id)!.capabilities!, generation: generation as number } }, serverEvents.captureTransportAuthority())
  status(a, "connected", ++sourceGeneration)
  ask(a, "form")
  assert.equal(canAnswerInterruption(a.id, "form", getFormQueue(a.id)[0]), false)
  await assert.rejects(sendFormCancel(a.id, "same-form"))
  assert.equal(a.calls.length, 0)
})

test("native interruption dispatch logs event kinds without answers or permission feedback", t => {
  const a = owner(), entries: unknown[] = []
  t.mock.method(getLogger("sse"), "info", (...args: unknown[]) => { entries.push(args) })
  ask(a, "form")
  emit(a, "form.replied", { id: "same-form", answer: { answer: "owned-answer-sentinel" } })
  emit(a, "permission.asked", { id: "same-permission", action: "read", resources: ["owned"], message: "owned-feedback-sentinel" })
  assert(entries.length > 0)
  assert.equal(JSON.stringify(entries).includes("owned-answer-sentinel"), false)
  assert.equal(JSON.stringify(entries).includes("owned-feedback-sentinel"), false)
})
