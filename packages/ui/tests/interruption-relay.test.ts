import assert from "node:assert/strict"
import { test } from "node:test"
import { OpenCode } from "@opencode/client"
import toast from "solid-toast"
import { EventBus } from "../../server/src/events/bus"
import { InstanceEventBridge } from "../../server/src/workspaces/instance-events"
import { initialServerCapabilities } from "../../server/src/opencode/servers/capabilities"
import { serverEvents } from "../src/lib/server-events"
import { addInstance, removeInstance, updateInstance, instances } from "../src/stores/instances"
import { getFormQueue } from "../src/stores/forms"
import { canAnswerInterruption } from "../src/stores/interruption-authority"

const turn = () => new Promise<void>(resolve => setImmediate(resolve))
async function until(check: () => boolean) {
  const end = Date.now() + 3000
  while (!check()) { assert(Date.now() < end, "owned relay did not settle"); await turn() }
}
for (const gap of [false, true]) for (const metadataLate of [false, true]) test(`real relay owns native connection correlation across gap=${gap}, metadataLate=${metadataLate}`, async t => {
  const id = `review-real-gap-${gap}-${metadataLate}`, directory = "/same/opaque", serverId = "review-relay-source"
  const originalToast = toast.custom; toast.custom = () => "review-only"
  const capabilities = initialServerCapabilities({ id: serverId, kind: "explicit", label: serverId, origin: "http://127.0.0.1" }, 42)
  for (const key of ["questions", "permissions", "events"] as const) capabilities.features[key] = { state: "available", reason: { code: "contractVerified" }, evidence: "nativeContract" }
  addInstance({ id, folder: directory, binding: { serverId, directory }, capabilities: metadataLate ? { ...capabilities, generation: 0 } : capabilities, client: OpenCode.make({ baseUrl: "http://127.0.0.1", fetch: async () => { throw new Error("forbidden UI IO") } }),
    proxyPath: `/workspaces/${id}/instance`, status: "ready", port: 0, pid: 0 }, serverEvents.captureTransportAuthority())
  const bus = new EventBus(), frames: any[] = [], events: any[] = []
  let wake: (() => void) | undefined
  const emit = (type: string, data: any, location?: any) => { events.push({ id: `event-${events.length}-${Date.now()}`, created: Date.now(), type, data, location }); wake?.() }
  bus.onEvent(frame => {
    frames.push(frame)
    // Native serialization strips object identity, as the SSE route does.
    ;(serverEvents as any).dispatchBatch([JSON.parse(JSON.stringify(frame))])
  })
  const signal = new AbortController()
  const connection = { signal: signal.signal, generation: 42, endpoint: { url: "http://127.0.0.1" }, assertCurrent() { signal.signal.throwIfAborted() },
    client: { event: { subscribe: ({ signal }: { signal: AbortSignal }) => (async function* () {
      yield { id: "connected", created: 1, type: "server.connected", data: {} }
      while (!signal.aborted) {
        if (events.length) yield events.shift()
        else await new Promise<void>(resolve => {
          const done = () => { signal.removeEventListener("abort", done); resolve() }
          wake = done
          if (signal.aborted) done()
          else signal.addEventListener("abort", done, { once: true })
        })
      }
    })() }, session: { get: async ({ sessionID }: any) => {
      assert.equal(sessionID, "missing", "only existing relay placement lookup is authorized")
      throw Object.assign(new Error("missing"), { _tag: "SessionNotFoundError" })
    } } }, invalidate() { signal.abort() } }
  const bridge = new InstanceEventBridge({ eventBus: bus, logger: { debug() {}, warn() {} } as any, workspaceManager: {
    list: () => [{ id, path: directory, binding: { serverId, directory } }],
    observeAdmittedEventSources(listener: any) { listener([serverId]); return () => {} },
    getServerConnections: () => ({ acquireForServer: async (requested: string) => { assert.equal(requested, serverId); return connection } }),
    ownsLocation: async (requested: string, location: any) => requested === id && location.directory === directory && location.workspaceID === undefined,
  } as any })
  t.after(() => { bridge.shutdown(); signal.abort(); wake?.(); removeInstance(id, { authoritative: false }); toast.custom = originalToast })
  await until(() => frames.some(frame => frame.type === "instance.event" && frame.event.type === "server.connected"))
  if (gap) {
    emit("session.deleted", { sessionID: "missing" })
    await until(() => frames.some(frame => frame.type === "instance.eventStatus" && frame.gap === "ownership"))
    assert.equal(frames.at(-1).status, "connected")
  }
  emit("form.created", { form: { id: "fresh-form", sessionID: "global", title: "fresh", fields: [], state: { status: "pending" } } }, { directory })
  await until(() => getFormQueue(id).length === 1)
  const captured = getFormQueue(id)[0]
  if (metadataLate) {
    assert.equal(canAnswerInterruption(id, "form", captured), false)
    updateInstance(id, { capabilities }, serverEvents.captureTransportAuthority())
    assert.equal(getFormQueue(id)[0], captured)
  }
  const fresh = frames.find(frame => frame.type === "instance.event" && frame.event.type === "form.created")
  assert.equal(fresh.source.connectionGeneration, connection.generation)
  assert.notEqual(fresh.source.generation, connection.generation)
  assert(Number.isSafeInteger(fresh.liveGeneration) && fresh.liveGeneration > 0)
  const statuses = frames.filter(frame => frame.type === "instance.eventStatus").map(({ status, source, gap }) => ({ status, relay: source.generation, gap }))
  console.log(JSON.stringify({ gap, capabilities: instances().get(id)!.capabilities!.generation, statuses, fresh: canAnswerInterruption(id, "form", getFormQueue(id)[0]) }))
  assert.equal(canAnswerInterruption(id, "form", getFormQueue(id)[0]), true, "fresh request from the real healthy relay must be answerable after its routing pulse")
})
