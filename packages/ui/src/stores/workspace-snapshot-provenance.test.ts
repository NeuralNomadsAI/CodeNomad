import assert from "node:assert/strict"
import { test } from "node:test"
import { OpenCode } from "@opencode/client"
import toast from "solid-toast"
import { initialServerCapabilities } from "../../../server/src/opencode/servers/capabilities"
import { serverEvents } from "../lib/server-events"
import { serverApi } from "../lib/api-client"
import { sdkManager } from "../lib/sdk-manager"
import { addInstance, updateInstance, removeInstance, instances, sendFormCancel, createInstance } from "./instances"
import { getFormQueue } from "./forms"
import { canAnswerInterruption } from "./interruption-authority"

let sequence = 0
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function harness(t: any) {
  const id = `snapshot-${++sequence}`, directory = "/工作/100% ready", serverId = `source-${sequence}`
  const oldToast = toast.custom, oldSdk = sdkManager.createClient
  toast.custom = () => "owned-only"
  let calls = 0, clock = 0
  const client = OpenCode.make({ baseUrl: "http://127.0.0.1", fetch: async (input, init) => {
    assert.equal(init?.method, "DELETE", "zero compensating reads or replay")
    assert.match(String(input), /\/api\/session\/global\/form\/current$/)
    calls++; return new Response(null, { status: 204 })
  } })
  sdkManager.createClient = () => client
  const caps = initialServerCapabilities({ id: serverId, kind: "explicit", label: "Same label", origin: "http://127.0.0.1" }, 1)
  for (const key of ["questions", "permissions", "events"] as const) caps.features[key] = { state: "available", reason: { code: "contractVerified" }, evidence: "nativeContract" }
  const descriptor = { id, path: directory, name: "owned-only", binding: { serverId, directory }, capabilities: caps,
    proxyPath: `/workspaces/${id}/instance`, status: "ready" as const, createdAt: "2026-01-01", updatedAt: "2026-01-01" }
  addInstance({ ...descriptor, folder: directory, client, port: 0, pid: 0 }, serverEvents.captureTransportAuthority())
  const send = (frame: any) => (serverEvents as any).dispatchBatch([frame])
  const status = (relay: number, boundary: number) => send({ type: "instance.eventStatus", instanceId: id, status: "connected",
    source: { serverId, generation: relay, connectionGeneration: 1 }, liveGeneration: boundary })
  const ask = (relay: number, boundary: number) => send({ type: "instance.event", instanceId: id,
    source: { serverId, generation: relay, connectionGeneration: 1 }, liveGeneration: boundary,
    event: { id: `event-${++clock}`, created: clock, type: "form.created", location: { directory },
      data: { form: { id: "current", sessionID: "global", title: "owned-only", fields: [], state: { status: "pending" } } } } })
  t.after(() => { removeInstance(id, { authoritative: false }); toast.custom = oldToast; sdkManager.createClient = oldSdk })
  const answerable = () => canAnswerInterruption(id, "form", getFormQueue(id)[0])
  return { id, descriptor, caps, send, status, ask, answerable, calls: () => calls,
    gap() { (serverEvents as any).emitTransportStatus("disconnected"); status(101, 11); ask(101, 11); assert.equal(answerable(), false) },
    fresh() { send({ type: "workspace.started", workspace: descriptor }) },
  }
}

test("missing capabilities and display-only copies preserve old provenance; fresh ingress qualifies without another event", async t => {
  const h = harness(t)
  h.status(100, 10); h.ask(100, 10); assert(h.answerable())
  const saved = { ...instances().get(h.id)! }
  h.gap()
  const { capabilities, ...withoutCapabilities } = h.descriptor
  h.send({ type: "workspace.started", workspace: withoutCapabilities })
  assert.equal(h.answerable(), false)
  updateInstance(h.id, { ...saved })
  assert.equal(h.answerable(), false)
  updateInstance(h.id, { capabilities: { ...capabilities } })
  assert.equal(h.answerable(), false, "unknown copies acquire no publication authority")
  h.fresh()
  assert.equal(h.answerable(), true)
  updateInstance(h.id, { ...saved })
  assert.equal(h.answerable(), false, "fresh ingress must not retag a retained capability reference")
  h.fresh(); assert.equal(h.answerable(), true)
  assert.equal(h.calls(), 0)
  await sendFormCancel(h.id, "current"); assert.equal(h.calls(), 1)
})

test("held HTTP create retains the transport at dispatch; equal native counters across transports confer no proof", async t => {
  const h = harness(t), oldCreate = serverApi.createWorkspace, held = deferred<any>()
  serverApi.createWorkspace = () => held.promise
  t.after(() => { serverApi.createWorkspace = oldCreate })
  h.status(100, 10); h.ask(100, 10); assert(h.answerable())
  const pending = createInstance(h.descriptor.path)
  h.gap()
  held.resolve({ ...h.descriptor, reused: true })
  await pending
  assert.equal(h.answerable(), false)
  h.fresh(); assert.equal(h.answerable(), true)
  await sendFormCancel(h.id, "current"); assert.equal(h.calls(), 1)
})

test("reconnect list fence rejects the superseded response then current snapshot qualifies once", async t => {
  const h = harness(t), oldList = serverApi.fetchWorkspaces, releases: Array<(value: any) => void> = []
  serverApi.fetchWorkspaces = () => new Promise(resolve => { releases.push(resolve) })
  t.after(() => { serverApi.fetchWorkspaces = oldList })
  h.status(100, 10); h.ask(100, 10); assert(h.answerable())
  for (const handler of (serverEvents as any).openHandlers) handler()
  assert.equal(releases.length, 1)
  h.gap()
  for (const handler of (serverEvents as any).openHandlers) handler()
  assert.equal(releases.length, 2)
  h.status(102, 12); h.ask(102, 12)
  releases[0]([h.descriptor]); await turn(); assert.equal(h.answerable(), false)
  releases[1]([h.descriptor]); await turn(); assert.equal(h.answerable(), true)
  await sendFormCancel(h.id, "current"); assert.equal(h.calls(), 1)
})

for (const eventIsCurrent of [false, true]) test(`deferred restore selection retains selected event owner, current=${eventIsCurrent}`, async t => {
  const h = harness(t), oldCreate = serverApi.createWorkspace, response = deferred<any>(), commit = deferred<void>()
  let requestId: string | undefined
  serverApi.createWorkspace = input => { requestId = input.requestId; return response.promise }
  t.after(() => { serverApi.createWorkspace = oldCreate })
  h.status(100, 10); h.ask(100, 10)
  const pending = createInstance(h.descriptor.path, undefined, { signal: new AbortController().signal, waitForCreateCommit: () => commit.promise })
  assert(requestId)
  if (eventIsCurrent) h.gap()
  h.send({ type: "workspace.started", workspace: { ...h.descriptor, requestId, updatedAt: "2026-02-01" } })
  if (!eventIsCurrent) h.gap()
  response.resolve({ ...h.descriptor, requestId, reused: true })
  await turn()
  commit.resolve(); await pending
  assert.equal(h.answerable(), eventIsCurrent, "selected deferred event retains its own ingress, not the HTTP owner")
  if (!eventIsCurrent) { h.fresh(); assert.equal(h.answerable(), true) }
  await sendFormCancel(h.id, "current"); assert.equal(h.calls(), 1)
})

test("restore commit wait cannot relabel already-received HTTP metadata", async t => {
  const h = harness(t), oldCreate = serverApi.createWorkspace, response = deferred<any>(), commit = deferred<void>()
  serverApi.createWorkspace = () => response.promise
  t.after(() => { serverApi.createWorkspace = oldCreate })
  h.status(100, 10); h.ask(100, 10)
  const pending = createInstance(h.descriptor.path, undefined, { signal: new AbortController().signal, waitForCreateCommit: () => commit.promise })
  response.resolve({ ...h.descriptor, reused: true }); await turn()
  h.gap(); commit.resolve(); await pending
  assert.equal(h.answerable(), false)
  h.fresh(); assert.equal(h.answerable(), true)
  await sendFormCancel(h.id, "current"); assert.equal(h.calls(), 1)
})

test("old higher metadata is display-only and cannot retire a lower current-transport candidate", async t => {
  const h = harness(t), oldOwner = serverEvents.captureTransportAuthority()
  h.status(100, 10); h.ask(100, 10)
  h.gap()
  updateInstance(h.id, { capabilities: { ...h.caps, generation: 99 } }, oldOwner)
  assert.equal(h.answerable(), false)
  h.fresh(); assert.equal(h.answerable(), true, "fresh matching metadata qualifies the held native candidate")
  await sendFormCancel(h.id, "current"); assert.equal(h.calls(), 1)
})

test("failed restore cleanup republishes its retained snapshot without acquiring the completion transport", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const h = harness(t), oldCreate = serverApi.createWorkspace, oldCancel = serverApi.cancelWorkspaceCreation
  const held = deferred<any>(); let cancellations = 0
  serverApi.createWorkspace = async input => ({ ...h.descriptor, reused: true, requestId: input.requestId })
  serverApi.cancelWorkspaceCreation = () => { cancellations++; return cancellations === 1 ? held.promise : Promise.reject(new Error("synthetic refusal")) }
  t.after(() => { serverApi.createWorkspace = oldCreate; serverApi.cancelWorkspaceCreation = oldCancel })
  h.status(100, 10); h.ask(100, 10)
  const pending = createInstance(h.descriptor.path, undefined, { signal: new AbortController().signal, shouldCreateCommit: () => false })
  const rejected = assert.rejects(pending)
  await turn(); assert.equal(cancellations, 1)
  h.gap(); held.resolve(Promise.reject(new Error("synthetic refusal")))
  for (const delay of [250, 1000, 2000]) { await turn(); t.mock.timers.tick(delay); await turn() }
  await rejected
  assert.equal(cancellations, 4)
  assert.equal(h.answerable(), false)
  h.fresh(); assert.equal(h.answerable(), true)
  await sendFormCancel(h.id, "current"); assert.equal(h.calls(), 1)
})
