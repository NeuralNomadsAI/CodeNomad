import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"
import toast from "solid-toast"
import { OpenCode, type OpenCodeClient } from "@opencode/client"
import { initialServerCapabilities } from "../../../server/src/opencode/servers/capabilities"
import { addInstance, removeInstance, updateInstance, instances, sendFormReply, getPermissionQueue, addPendingForm, incompletePendingRecovery } from "./instances"
import { getFormQueue, type FormWithLocation } from "./forms"
import { setSessions, sessions, captureSessionPlacementAuthority } from "./session-state"
import { canAnswerInterruption } from "./interruption-authority"
import { verifyKnownForm, formVerificationStatus, canVerifyKnownForm } from "./form-verification"
import { serverEvents } from "../lib/server-events"
import { sdkManager } from "../lib/sdk-manager"
import { backgroundReads } from "../lib/background-read-queue"
import { hasSettledForm } from "./form-settlements"
import { handleNativeSessionEvent } from "./session-events"

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const directory = "/工作/%25 é", fields = [{ key: "answer", type: "string" }]
let sequence = 0, boundary = 100, nextSource = 100
type Owner = { id: string; server: string; global: boolean; calls: { path: string; method: string; headers: Headers }[];
  client: OpenCodeClient; status: string; fail: boolean; source: number; hold?: ReturnType<typeof deferred>; entered: ReturnType<typeof deferred>; mutateHold: boolean;
  context: { source: { serverId: string; generation: number; connectionGeneration: number }; liveGeneration: number } }
const owners: Owner[] = [], originalCreate = sdkManager.createClient
const originalToast = toast.custom
beforeEach(() => { toast.custom = () => "owned-verification-toast" })
afterEach(() => {
  for (const item of owners.splice(0)) { item.hold?.resolve(); removeInstance(item.id, { authoritative: false }); setSessions(previous => { const next = new Map(previous); next.delete(item.id); return next }) }
  sdkManager.createClient = originalCreate
  toast.custom = originalToast
})
function owner(server = "A", global = false): Owner {
  const id = `verify-${++sequence}`, calls: { path: string; method: string; headers: Headers }[] = []
  const item = { id, server, global, calls, client: undefined as unknown as OpenCodeClient, status: "pending", fail: false,
    source: ++nextSource, hold: undefined as ReturnType<typeof deferred> | undefined, entered: deferred(), mutateHold: false,
    context: { source: { serverId: server, generation: 10, connectionGeneration: 1 }, liveGeneration: ++boundary } }
  item.client = OpenCode.make({ baseUrl: `http://127.0.0.1/${id}`, fetch: async (input, init) => {
    const path = new URL(String(input)).pathname, method = init?.method ?? "GET"
    assert(/\/api\/session\/(ses_s|global)\/form\/frm_q(?:\/reply)?$/.test(path), `Forbidden native read ${path}`)
    calls.push({ path, method, headers: new Headers(init?.headers) }); item.entered.resolve()
    if (method === "GET" || item.mutateHold) await item.hold?.promise
    if (item.fail) return Response.json({ _tag: "PermissionNotFoundError", requestID: "frm_q" }, { status: 404 })
    return method === "GET" ? Response.json({ data: { id: "frm_q", sessionID: global ? "global" : "ses_s", title: "Known", fields, state: { status: item.status } } }) : new Response(null, { status: 204 })
  } })
  owners.push(item)
  sdkManager.createClient = id => owners.find(owner => owner.id === id)!.client
  const capabilities = initialServerCapabilities({ id: server, kind: "explicit", label: server, origin: "https://example.invalid" }, 1)
  for (const name of ["questions", "permissions", "events"] as const) capabilities.features[name] = { state: "available", reason: { code: "contractVerified" }, evidence: "nativeContract" }
  addInstance({ id, folder: directory, binding: { serverId: server, directory }, capabilities, client: item.client, proxyPath: `/workspaces/${id}/instance`, status: "ready", port: 0, pid: 0 }, serverEvents.captureTransportAuthority())
  setSessions(previous => new Map(previous).set(id, new Map([["ses_s", { id: "ses_s", instanceId: id, title: "Same", parentId: null, location: { directory }, status: "idle", time: { created: 1, updated: 1 } } as any]])))
  status(item, "connected"); ask(item); status(item, "disconnected"); item.source = ++nextSource; status(item, "connected")
  return item
}
function status(item: ReturnType<typeof owner>, status: string) {
  item.context = { source: { serverId: item.server, generation: item.source, connectionGeneration: 1 }, liveGeneration: ++boundary }
  ;(serverEvents as any).dispatchBatch([{ type: "instance.eventStatus", instanceId: item.id, ...item.context, status }])
}
function ask(item: ReturnType<typeof owner>) {
  const data = { sessionID: item.global ? "global" : "ses_s", form: { id: "frm_q", sessionID: item.global ? "global" : "ses_s", title: "Known", fields, state: { status: "pending" } } }
  ;(serverEvents as any).dispatchBatch([{ type: "instance.event", instanceId: item.id, ...item.context,
    event: { id: `evt_${++boundary}`, created: boundary, type: "form.created", location: { directory }, data } }])
}
const held = (item: ReturnType<typeof owner>) => getFormQueue(item.id)[0]
const move = (item: Owner, target: string) => handleNativeSessionEvent(item.id, { id: `move_${++boundary}`, created: boundary,
  type: "session.moved", location: { directory }, data: { sessionID: "ses_s", location: { directory: target }, projectID: "owned-project" } } as any)

test("a native event interleaved before the actual abortable callback dispatches zero stale GETs", async () => {
  const a = owner(), form = held(a)
  const read = verifyKnownForm(a.id, form)
  queueMicrotask(() => ask(a))
  await read
  assert.equal(a.calls.length, 0)
  assert.equal(formVerificationStatus(form), undefined)
  assert.equal(canAnswerInterruption(a.id, "form", held(a)), true)
})

for (const returned of [false, true]) test(`native placement ${returned ? "ABA" : "A-B"} irreversibly retires a held GET; new gesture after return is positive`, async () => {
  const a = owner(), form = held(a); a.hold = deferred()
  const read = verifyKnownForm(a.id, form); await a.entered.promise
  move(a, "/elsewhere")
  if (returned) move(a, directory)
  a.hold.resolve(); await read
  assert.equal(formVerificationStatus(form), undefined)
  assert.equal(canAnswerInterruption(a.id, "form", form), false)
  assert.equal(a.calls.length, 1)
  if (!returned) move(a, directory)
  a.hold = undefined
  await verifyKnownForm(a.id, form)
  assert.equal(formVerificationStatus(form), "pending")
  assert.equal(canAnswerInterruption(a.id, "form", form), true)
  assert.equal(a.calls.length, 2)
})

test("already-verified pending authority stays retired after placement ABA; same placement is idempotent", async () => {
  const a = owner(), form = held(a)
  await verifyKnownForm(a.id, form)
  move(a, directory)
  assert.equal(canAnswerInterruption(a.id, "form", form), true)
  move(a, "/elsewhere")
  assert.equal(canAnswerInterruption(a.id, "form", form), false)
  move(a, directory)
  assert.equal(canAnswerInterruption(a.id, "form", form), false)
  assert.equal(formVerificationStatus(form), undefined)
  await verifyKnownForm(a.id, form)
  assert.equal(canAnswerInterruption(a.id, "form", form), true)
  assert.equal(a.calls.length, 2)
})

test("live session Form admission also retires on placement ABA, while global Form admission keeps its directory owner", () => {
  const a = owner(), global = owner("B", true)
  ask(a); ask(global)
  const form = held(a), projectForm = held(global)
  assert.equal(canAnswerInterruption(a.id, "form", form), true)
  move(a, "/elsewhere"); move(a, directory)
  move(global, "/elsewhere"); move(global, directory)
  assert.equal(canAnswerInterruption(a.id, "form", form), false)
  assert.equal(canAnswerInterruption(global.id, "form", projectForm), true)
  ask(a)
  assert.equal(canAnswerInterruption(a.id, "form", held(a)), true)
})

test("a cold live Form stays answerable through first same-placement hydration; removal/reuse retires it", () => {
  const a = owner(), row = { id: "ses_s", instanceId: a.id, title: "Same", parentId: null, location: { directory }, status: "idle", time: { created: 1, updated: 1 } } as any
  setSessions(previous => new Map(previous).set(a.id, new Map()))
  ask(a)
  const form = held(a)
  assert.equal(canAnswerInterruption(a.id, "form", form), true)
  setSessions(previous => new Map(previous).set(a.id, new Map([[row.id, row]])))
  assert.equal(canAnswerInterruption(a.id, "form", form), true)
  setSessions(previous => new Map(previous).set(a.id, new Map()))
  setSessions(previous => new Map(previous).set(a.id, new Map([[row.id, row]])))
  assert.equal(canAnswerInterruption(a.id, "form", form), false)
  ask(a)
  assert.equal(canAnswerInterruption(a.id, "form", held(a)), true)
  assert.equal(a.calls.length, 0)
})

test("occurrence destruction retires placement owners even while display session rows remain", () => {
  const a = owner(), current = captureSessionPlacementAuthority(a.id, "ses_s")
  assert.equal(current(), true)
  removeInstance(a.id, { authoritative: false })
  assert.equal(sessions().get(a.id)?.has("ses_s"), true, "retained rows are display data")
  assert.equal(current(), false)
})

test("a known stale Form requires one explicit GET then a separate manual mutation; sibling A/B and coverage unchanged", async () => {
  const a = owner(), b = owner("B"), global = owner("C", true)
  for (const item of [a, b, global]) assert.equal(canAnswerInterruption(item.id, "form", held(item)), false)
  assert.equal(a.calls.length + b.calls.length + global.calls.length, 0)
  const original = held(a)
  await verifyKnownForm(a.id, original)
  assert.equal(formVerificationStatus(original), "pending")
  assert.equal(canAnswerInterruption(a.id, "form", original), true)
  assert.equal(canAnswerInterruption(b.id, "form", held(b)), false)
  assert.equal(a.calls.length, 1); assert.equal(b.calls.length, 0)
  assert.equal(incompletePendingRecovery().has(a.id), true)
  assert.equal(getFormQueue(a.id)[0], original)
  assert.equal(hasSettledForm(a.id, original.id), false)
  await sendFormReply(a.id, original.id, { answer: "manual" })
  assert.deepEqual(a.calls.map(call => call.method), ["GET", "POST"])
  assert.equal(a.calls[1].headers.get("x-codenomad-human-answer"), null)
  await verifyKnownForm(global.id, held(global))
  assert.equal(global.calls[0].headers.get("x-opencode-directory"), encodeURIComponent(directory))
  assert.equal(global.calls[0].headers.get("x-codenomad-connection-generation"), "1")
})
for (const state of ["answered", "cancelled"]) test(`${state} stays neutral without queue removal, tombstone or permission authority`, async () => {
  const a = owner(), form = held(a); a.status = state
  await verifyKnownForm(a.id, form)
  assert.equal(formVerificationStatus(form), state)
  assert.equal(canAnswerInterruption(a.id, "form", form), false)
  assert.equal(held(a), form); assert.equal(hasSettledForm(a.id, form.id), false)
  await assert.rejects(sendFormReply(a.id, form.id, { answer: "never sent" }))
  assert.equal(a.calls.length, 1); assert.equal(getPermissionQueue(a.id).length, 0)
})
test("indeterminate stays editable/inert; another deliberate gesture can recover with a positive pending result", async () => {
  const a = owner(), form = held(a); a.fail = true
  await verifyKnownForm(a.id, form)
  assert.equal(formVerificationStatus(form), "indeterminate")
  assert.equal(canAnswerInterruption(a.id, "form", form), false)
  assert.equal(a.calls.length, 1)
  a.fail = false
  await verifyKnownForm(a.id, form)
  assert.equal(formVerificationStatus(form), "pending")
  assert.equal(canAnswerInterruption(a.id, "form", form), true)
  assert.equal(a.calls.length, 2)
})
for (const change of ["native-event", "rotate", "rebind-ABA", "close-reuse", "backend-reset"] as const) test(`${change} fences a held old result without publication`, async () => {
  const a = owner(), form = held(a); a.hold = deferred()
  const read = verifyKnownForm(a.id, form); await a.entered.promise
  if (change === "native-event") ask(a)
  if (change === "rotate") updateInstance(a.id, { capabilities: { ...instances().get(a.id)!.capabilities!, generation: 2 } }, serverEvents.captureTransportAuthority())
  if (change === "rebind-ABA") { updateInstance(a.id, { binding: { serverId: "B", directory } }); updateInstance(a.id, { binding: { serverId: "A", directory } }) }
  if (change === "close-reuse") { const saved = instances().get(a.id)!; removeInstance(a.id, { authoritative: false }); addInstance(saved, serverEvents.captureTransportAuthority()) }
  if (change === "backend-reset") { (serverEvents as any).emitTransportStatus("disconnected"); status(a, "connected"); updateInstance(a.id, { capabilities: { ...instances().get(a.id)!.capabilities!, generation: 1 } }, serverEvents.captureTransportAuthority()) }
  a.hold.resolve(); await read
  assert.equal(formVerificationStatus(form), undefined)
  assert.equal(a.calls.length, 1)
  if (change === "native-event") assert.equal(canAnswerInterruption(a.id, "form", held(a)), true)
  else assert.equal(canAnswerInterruption(a.id, "form", held(a)), false)
})
test("elapsed verification deadline cannot publish pending before its timer gets a turn", async t => {
  const a = owner(), form = held(a); a.hold = deferred()
  let elapsed = performance.now()
  t.mock.method(performance, "now", () => elapsed)
  const read = verifyKnownForm(a.id, form); await a.entered.promise
  elapsed += 10_001; a.hold.resolve(); await read
  assert.equal(formVerificationStatus(form), "indeterminate")
  assert.equal(canAnswerInterruption(a.id, "form", form), false)
  assert.equal(a.calls.length, 1)
})

test("a guessed/foreign source object grants no verification; queue waits retain captured request and global secondary slots", async () => {
  const a = owner(), b = owner("B"), c = owner("C"), d = owner("D"), form = held(a), gate = deferred()
  const occupied = [1, 2].map(() => backgroundReads.run(new AbortController().signal, () => gate.promise))
  const reading = verifyKnownForm(a.id, form)
  ask(a) // Even an equal native payload retires the queued read.
  gate.resolve(); await Promise.all([...occupied, reading])
  assert.equal(a.calls.length, 0)
  await verifyKnownForm(b.id, held(a))
  await verifyKnownForm(b.id, { ...held(b) } as FormWithLocation)
  assert.equal(b.calls.length, 0)
  for (const item of [b, c, d]) { item.hold = deferred(); item.entered = deferred() }
  const first = verifyKnownForm(b.id, held(b)), second = verifyKnownForm(c.id, held(c))
  await Promise.all([b.entered.promise, c.entered.promise])
  assert.equal(b.calls.length + c.calls.length, 2)
  const third = verifyKnownForm(d.id, held(d))
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(d.calls.length, 0, "two real Form reads hold the same global lane")
  b.hold!.resolve(); await d.entered.promise
  c.hold!.resolve(); d.hold!.resolve(); await Promise.all([first, second, third])
  assert.equal(canAnswerInterruption(b.id, "form", held(b)), true)
  assert.equal(canAnswerInterruption(c.id, "form", held(c)), true)
  const unknown = { ...held(c), id: "guessed" }
  addPendingForm(c.id, unknown) // No captured source registry entry: queue alone is insufficient.
  assert.equal(canVerifyKnownForm(c.id, unknown), false)
})
