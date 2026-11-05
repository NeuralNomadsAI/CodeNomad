import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { OpenCode } from "@opencode/client"
import toast from "solid-toast"
import { initialServerCapabilities } from "../../../server/src/opencode/servers/capabilities"
import { sdkManager } from "../lib/sdk-manager"
import { serverEvents } from "../lib/server-events"
import { addInstance, updateInstance, removeInstance, instances, sendFormCancel, getPermissionQueue, sendPermissionResponse } from "./instances"
import { getFormQueue } from "./forms"
import { canAnswerInterruption } from "./interruption-authority"
import { setSessions } from "./session-state"

// Real stores, dispatcher and official SDK; no network.
const originalClient = sdkManager.createClient, originalToast = toast.custom
let sequence = 0, eventSequence = 0
const ids: string[] = []
let liveBoundary = 5000
const correlations = new Map<string, { source: { serverId: string; generation: number; connectionGeneration: number }; liveGeneration: number }>()
const correlationKey = (id: string, relay: number) => JSON.stringify([id, relay])
toast.custom = () => "review-only"
const caps = (generation: number) => {
  const value = initialServerCapabilities({ id: "review-source", kind: "explicit", label: "review", origin: "http://127.0.0.1" }, generation)
  for (const key of ["questions", "permissions", "events"] as const) value.features[key] = { state: "available", reason: { code: "contractVerified" }, evidence: "nativeContract" }
  return value
}
function harness(generation = 1) {
  const id = `review-order-${++sequence}`, directory = "/工作/100% ready", calls: string[] = []
  const client = OpenCode.make({ baseUrl: `http://127.0.0.1/${id}`, fetch: async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname
    assert.equal(init?.method, "DELETE", `forbidden read/dispatch ${path}`)
    assert.match(path, /\/api\/session\/same-session\/form\/same-form$/)
    calls.push(path)
    return new Response(null, { status: 204 })
  } })
  sdkManager.createClient = () => client
  addInstance({ id, folder: directory, binding: { serverId: "review-source", directory }, capabilities: caps(generation), client,
    proxyPath: `/workspaces/${id}/instance`, status: "ready", pid: 0, port: 0 }, serverEvents.captureTransportAuthority())
  ids.push(id)
  setSessions(previous => new Map(previous).set(id, new Map([["same-session", { id: "same-session", instanceId: id,
    location: { directory }, title: "synthetic", status: "idle", parentId: null, time: { created: 1, updated: 1 } } as any]])))
  let nativeGeneration = generation || 2
  const status = (generation: number, status = "connected") => {
    const key = correlationKey(id, generation)
    // A repeated connected frame is the original snapshot, not a new backend pulse.
    const correlation = status === "connected" && correlations.get(key) || {
      source: { serverId: "review-source", generation, connectionGeneration: nativeGeneration }, liveGeneration: ++liveBoundary,
    }
    if (status === "connected") correlations.set(key, correlation)
    ;(serverEvents as any).dispatchBatch([{ type: "instance.eventStatus", instanceId: id, ...correlation, status }])
  }
  const emit = (generation: number, type: string, data: unknown) => (serverEvents as any).dispatchBatch([{ type: "instance.event", instanceId: id,
    ...correlations.get(correlationKey(id, generation)), event: { id: `review-event-${++eventSequence}`, created: eventSequence, type, location: { directory }, data } }])
  const ask = (generation: number) => {
    emit(generation, "form.created", { form: { id: "same-form", sessionID: "same-session", title: "synthetic", fields: [], state: { status: "pending" } } })
    return getFormQueue(id)[0]
  }
  return { id, calls, status, ask, emit, native: (generation: number) => { nativeGeneration = generation }, metadata: (generation: number) => updateInstance(id, { capabilities: caps(generation) }, serverEvents.captureTransportAuthority()),
    answerable: () => canAnswerInterruption(id, "form", getFormQueue(id)[0]) }
}
afterEach(() => {
  for (const id of ids.splice(0)) { removeInstance(id, { authoritative: false }); setSessions(previous => { const next = new Map(previous); next.delete(id); return next }) }
  sdkManager.createClient = originalClient
})
process.on("exit", () => { toast.custom = originalToast })

test("positive: descriptor BEFORE new relay handshake admits fresh live request and dispatches once", async () => {
  const h = harness(); h.native(2); h.metadata(2); h.status(1001); h.ask(1001)
  assert(h.answerable()); await sendFormCancel(h.id, "same-form"); assert.equal(h.calls.length, 1)
})
test("AC1.06 BLOCKER: descriptor AFTER handshake must still admit a subsequent fresh request", () => {
  const h = harness(); h.native(2); h.status(1010); h.metadata(2); h.ask(1010)
  assert.equal(h.answerable(), true, "current native event wrongly stays inert after metadata arrives")
})
test("AC1.06 BLOCKER: event between handshake and descriptor; a later current event must work", () => {
  const h = harness(); h.native(2); h.status(1020); h.ask(1020); h.metadata(2); h.ask(1020)
  assert.equal(h.answerable(), true, "even new live traffic on this healthy stream cannot repair admission")
})
test("AC1.06 BLOCKER: reconnect with old UI descriptor then fresh descriptor and live event", () => {
  const h = harness(); h.status(1030); h.ask(1030); h.status(1031, "disconnected"); h.native(2); h.status(1032); h.metadata(2); h.ask(1032)
  assert.equal(h.answerable(), true)
})
test("AC1.06 BLOCKER: late attach with generation zero; first current descriptor arrives after deferred status", () => {
  const nextId = `review-order-${sequence + 1}`
  const correlation = { source: { serverId: "review-source", generation: 1040, connectionGeneration: 2 }, liveGeneration: ++liveBoundary }
  correlations.set(correlationKey(nextId, 1040), correlation)
  ;(serverEvents as any).dispatchBatch([{ type: "instance.eventStatus", instanceId: nextId, status: "connected", ...correlation }])
  const h = harness(0); h.metadata(2); h.ask(1040)
  assert.equal(h.answerable(), true)
})
test("safety: gap plus same-handshake replay cannot reauthorize a retained request", async () => {
  const h = harness(); h.status(1050); h.ask(1050); assert(h.answerable())
  h.status(1050, "disconnected"); h.status(1050); h.ask(1050)
  assert.equal(h.answerable(), false); await assert.rejects(sendFormCancel(h.id, "same-form")); assert.equal(h.calls.length, 0)
})
test("safety: old source business frames and status cannot authorize after rotation", () => {
  const h = harness(); h.status(1060); h.ask(1060); h.native(2); h.metadata(2); h.status(1061); h.ask(1061); assert(h.answerable())
  const current = getFormQueue(h.id)[0]; h.status(1060); h.ask(1060)
  assert.equal(getFormQueue(h.id)[0], current); assert(h.answerable())
})
test("safety: late old metadata retires rather than authorizing the current request", async () => {
  const h = harness(); h.native(2); h.metadata(2); h.status(1070); h.ask(1070); assert(h.answerable()); h.metadata(1)
  assert.equal(h.answerable(), false); await assert.rejects(sendFormCancel(h.id, "same-form")); assert.equal(h.calls.length, 0)
})
test("safety: wrong-session native permission settlement cannot tombstone the queued owner", async () => {
  const h = harness(); h.status(1080)
  h.emit(1080, "permission.asked", { id: "same-permission", sessionID: "same-session", action: "read", resources: [] })
  const request = getPermissionQueue(h.id)[0]
  h.emit(1080, "permission.replied", { requestID: "same-permission", sessionID: "other-session", reply: "once" })
  assert.equal(getPermissionQueue(h.id)[0], request)
  await assert.rejects(sendPermissionResponse(h.id, "other-session", "same-permission", "once")); assert.equal(h.calls.length, 0)
})

test("matching late metadata qualifies its captured current candidate without another event or any read", async () => {
  const h = harness()
  h.native(2); h.status(1100); h.ask(1100)
  const captured = getFormQueue(h.id)[0]
  assert.equal(h.answerable(), false)
  h.metadata(2)
  assert.equal(h.answerable(), true)
  assert.equal(getFormQueue(h.id)[0], captured)
  assert.equal(h.calls.length, 0)
  await sendFormCancel(h.id, "same-form")
  assert.equal(h.calls.length, 1)
})

test("late metadata never re-admits a sibling from before the gap", async () => {
  const h = harness()
  h.status(1110)
  h.emit(1110, "permission.asked", { id: "same-permission", sessionID: "same-session", action: "read", resources: [] })
  h.status(1110, "disconnected")
  h.native(2); h.status(1111); h.ask(1111); h.metadata(2)
  assert.equal(h.answerable(), true)
  await assert.rejects(sendPermissionResponse(h.id, "same-session", "same-permission", "once"))
  assert.equal(h.calls.length, 0)
  assert.equal(getPermissionQueue(h.id).length, 1)
})

test("backend transport retirement cannot revalidate a captured callback through an identical status object", () => {
  const h = harness()
  h.status(1120); h.ask(1120)
  const correlation = correlations.get(correlationKey(h.id, 1120))!
  const frame = { type: "instance.event" as const, instanceId: h.id, ...correlation, event: {} as any }
  const captured = serverEvents.captureEventContext(frame)
  assert.equal(captured.current(), true)
  ;(serverEvents as any).emitTransportStatus("disconnected")
  h.status(1120)
  assert.equal(captured.current(), false)
  assert.equal(h.answerable(), false)
})

test("an older first handshake cannot borrow late old metadata after newer metadata was already installed", async () => {
  const h = harness(2)
  h.native(1); h.status(1130); h.ask(1130)
  assert.equal(h.answerable(), false)
  h.metadata(1)
  h.status(1130); h.ask(1130)
  assert.equal(h.answerable(), false)
  await assert.rejects(sendFormCancel(h.id, "same-form"))
  assert.equal(h.calls.length, 0)
  h.native(2); h.metadata(2); h.status(1131); h.ask(1131)
  assert.equal(h.answerable(), true)
  await sendFormCancel(h.id, "same-form")
  assert.equal(h.calls.length, 1)
})

test("occurrence close/reuse rejects the retired equal-boundary status and its old global creation", async () => {
  const h = harness()
  h.status(1140)
  const saved = instances().get(h.id)!
  removeInstance(h.id, { authoritative: false })
  addInstance({ ...saved, client: OpenCode.make({ baseUrl: "http://127.0.0.1", fetch: async () => { throw new Error("No replay dispatch") } }) })
  h.status(1140)
  h.emit(1140, "form.created", { form: { id: "same-form", sessionID: "global", title: "Old occurrence", fields: [], state: { status: "pending" } } })
  assert.equal(h.answerable(), false)
  await assert.rejects(sendFormCancel(h.id, "same-form"))
  assert.equal(h.calls.length, 0)
  const replacement = OpenCode.make({ baseUrl: "http://127.0.0.1", fetch: async (input, init) => {
    assert.equal(init?.method, "DELETE")
    h.calls.push(String(input))
    return new Response(null, { status: 204 })
  } })
  updateInstance(h.id, { client: replacement })
  sdkManager.createClient = () => replacement
  h.status(1141)
  h.emit(1141, "form.created", { form: { id: "same-form", sessionID: "global", title: "Current occurrence", fields: [], state: { status: "pending" } } })
  assert.equal(h.answerable(), true)
  await sendFormCancel(h.id, "same-form")
  assert.equal(h.calls.length, 1)
})

test("a new backend transport can qualify its fresh lower connection counter only after fresh metadata", async () => {
  const h = harness(42)
  h.status(1150); h.ask(1150); assert.equal(h.answerable(), true)
  ;(serverEvents as any).emitTransportStatus("disconnected")
  for (const handler of (serverEvents as any).openHandlers) handler()
  h.native(1); h.status(1151); h.ask(1151)
  assert.equal(h.answerable(), false, "cached capabilities from the prior transport grant nothing")
  h.metadata(1)
  assert.equal(h.answerable(), true)
  await sendFormCancel(h.id, "same-form")
  assert.equal(h.calls.length, 1)
})

test("another server's higher metadata counter never supersedes this server's native handshake", async () => {
  const h = harness(2)
  updateInstance(h.id, { capabilities: { ...caps(99), serverId: "other-server" } }, serverEvents.captureTransportAuthority())
  h.status(1160); h.ask(1160)
  assert.equal(h.answerable(), false)
  h.metadata(2)
  h.ask(1160)
  assert.equal(h.answerable(), true)
  await sendFormCancel(h.id, "same-form")
  assert.equal(h.calls.length, 1)
})
