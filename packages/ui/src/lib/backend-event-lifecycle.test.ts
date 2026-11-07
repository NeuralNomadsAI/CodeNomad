import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { createComputed, createRoot } from "solid-js"
import { createBackendClient } from "./backend-client"
import { backendEvents, ServerEvents } from "./server-events"
import { getSseManager, sseManager } from "./sse-manager"
import { useForegroundRefresh } from "./hooks/use-foreground-refresh"
import { integrationBindings, integrationEpoch } from "../stores/integrations"
import { registerLocalBackendFixture } from "../../tests/contracts/local-backend-fixture"

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function renderer(t: TestContext) {
  const before = Object.getOwnPropertyDescriptor(globalThis, "window")
  const window = Object.assign(new EventTarget(), { location: { origin: "https://ui.invalid" } })
  Object.defineProperty(globalThis, "window", { configurable: true, value: window })
  t.after(() => before ? Object.defineProperty(globalThis, "window", before) : Reflect.deleteProperty(globalThis, "window"))
  return window
}

function owner(t: TestContext, id: string) {
  const sources: { onopen?: () => void; close: () => void }[] = []
  const client = createBackendClient({ id, baseUrl: `https://${id}.invalid`,
    fetcher: async () => Response.json({}),
    eventSource: () => {
      const source = { onopen: undefined, close() {}, addEventListener() {} }
      sources.push(source)
      return source as unknown as EventSource
    },
  })
  // Capture transport callbacks through the real API instead of replacing dispatch.
  let event!: Parameters<typeof client.api.connectEvents>[0]
  const original = client.api.connectEvents
  client.api.connectEvents = (onEvent, onError, onPing) => {
    event = onEvent
    return original(onEvent, onError, onPing)
  }
  t.after(() => client.events.dispose())
  return { client, open: () => sources.at(-1)!.onopen!(), emit: (status: "connected" | "disconnected") => event({ type: "instance.eventStatus", instanceId: "ws", status, generation: 1 }) }
}

function counts() {
  const handlers = Reflect.get(backendEvents, "handlers") as Map<string, Set<unknown>>
  const statuses = Reflect.get(backendEvents, "statuses") as Set<unknown>
  return [handlers.get("instance.event")?.size ?? 0, handlers.get("instance.eventStatus")?.size ?? 0, statuses.size]
}

test("detach revokes transport, deletes reactive statuses and subscriptions, then reattachment has a fresh owner", async t => {
  renderer(t)
  const initial = counts(), a = owner(t, "removed"), b = owner(t, "kept")
  const detach = backendEvents.attach(a.client.id, a.client.events)
  t.after(detach)
  t.after(backendEvents.attach(b.client.id, b.client.events))
  a.client.events.start(); b.client.events.start()
  await tick()
  a.open(); b.open()
  a.emit("connected"); b.emit("connected")
  const old = getSseManager("removed"), seen: boolean[] = [], statuses: string[] = []
  createRoot(dispose => {
    t.after(dispose)
    createComputed(() => seen.push(sseManager.getStatuses().has("removed~ws")))
  })
  t.after(backendEvents.forInstance(() => "removed~ws").onTransportStatus(status => statuses.push(status)))
  detach(); detach()
  assert.deepEqual(statuses, ["disconnected"])
  assert.equal(sseManager.getStatus("removed~ws"), null)
  assert.equal(sseManager.getStatuses().has("removed~ws"), false)
  assert.equal(old.getStatuses().size, 0)
  assert.equal(seen.at(-1), false)
  assert.equal(sseManager.getStatus("kept~ws"), "connected")
  // Only the kept owner and this test's status observer remain above baseline.
  assert.deepEqual(counts(), [initial[0] + 1, initial[1] + 1, initial[2] + 2])
  a.emit("connected")
  assert.equal(sseManager.getStatus("removed~ws"), null)
  const replacement = owner(t, "removed")
  t.after(backendEvents.attach("removed", replacement.client.events))
  replacement.client.events.start()
  await tick()
  replacement.open()
  replacement.emit("connected")
  assert.notEqual(getSseManager("removed"), old)
  assert.equal(sseManager.getStatus("removed~ws"), "connected")
})

test("disposing an attached source removes its fan-in and integration connection records", async t => {
  registerLocalBackendFixture(t, "disposed_owner")
  renderer(t)
  const a = owner(t, "disposed_owner"), baseline = counts()
  let reads = 0
  t.mock.method(globalThis, "fetch", async () => { reads++; return Response.json({ state: "attached", label: "Scene" }) })
  const target = { instanceId: "disposed_owner~ws", directory: "/same", sessionID: "s", integrationId: "i" }
  t.after(backendEvents.attach(a.client.id, a.client.events))
  a.client.events.start()
  await tick()
  a.open()
  a.emit("connected")
  t.after(integrationBindings.demand(target))
  await tick()
  assert.deepEqual(integrationBindings.state(target), { state: "attached", label: "Scene" })
  a.client.events.dispose()
  assert.equal(sseManager.getStatus(target.instanceId), null)
  assert.equal(integrationEpoch(target.instanceId).split(":")[0], "0")
  assert.equal((Reflect.get(backendEvents, "sources") as Map<string, unknown>).has(a.client.id), false)
  assert.deepEqual(counts(), baseline)
  assert.deepEqual(integrationBindings.state(target), { state: "unknown" })
  const before = reads, replacement = owner(t, a.client.id)
  t.after(backendEvents.attach(replacement.client.id, replacement.client.events))
  replacement.client.events.start()
  await tick()
  replacement.open()
  await tick()
  assert.equal(reads, before + 1, "a retained view reacquires its binding under the replacement attachment")
  assert.deepEqual(integrationBindings.state(target), { state: "attached", label: "Scene" })
})

test("dispose fences pending connection acquisition even before it returns its transport", async t => {
  renderer(t)
  let closed = 0
  const events = new ServerEvents({
    api: { connectEvents: () => ({ close: () => closed++ }) as unknown as EventSource, sendClientConnectionPong: async () => {} },
    auth: { check: async () => {}, onRestored: () => () => false },
  })
  events.start()
  events.dispose()
  await tick()
  assert.equal(closed, 1, "a transport acquired after disposal must be closed by the generation fence")
  assert.equal(Reflect.get(events, "connection"), null)
})

test("dispose aborts an in-flight pong and cancels a failing pong's backoff and timeout", async t => {
  renderer(t)
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let ping!: (payload: { ts?: number }) => void, attempts = 0
  const signals: AbortSignal[] = []
  const events = new ServerEvents({
    api: {
      connectEvents: (_event, _error, onPing) => { ping = onPing!; return { close() {} } as EventSource },
      sendClientConnectionPong: async (_payload, signal) => { attempts++; signals.push(signal!); throw new Error("Failed to fetch") },
    }, auth: { check: async () => {}, onRestored: () => () => false },
  })
  t.after(() => events.dispose())
  events.start()
  await tick()
  ping({ ts: 1 })
  await tick() // First failure has installed the backoff.
  events.dispose()
  await tick()
  t.mock.timers.tick(20_000)
  await tick()
  assert.equal(attempts, 1)
  assert.equal(signals[0].aborted, true)
  assert.equal((Reflect.get(events, "lifetime") as AbortController).signal.aborted, true)
})

test("dispose releases browser/auth listeners and source subscribers, blocking late callbacks and reconnects", async t => {
  const window = renderer(t)
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
  const restored = new Set<() => void>()
  let opens = 0, connections = 0, status = 0, probes = 0
  let lateOpen!: () => void, lateError!: () => void
  const events = new ServerEvents({ api: {
    connectEvents: (_event, onError) => {
      connections++
      const source = { close() {}, onopen: undefined as (() => void) | undefined }
      lateError = onError!
      queueMicrotask(() => { lateOpen = source.onopen! })
      return source as unknown as EventSource
    }, sendClientConnectionPong: async () => {},
  }, auth: { check: async () => { probes++ }, onRestored: callback => { restored.add(callback); return () => restored.delete(callback) } } })
  events.onOpen(() => opens++)
  events.onTransportStatus(() => status++)
  events.start()
  await tick()
  lateOpen()
  const before = [opens, status]
  events.dispose()
  lateOpen(); lateError(); window.dispatchEvent(new Event("online"))
  t.mock.timers.tick(100_000)
  await tick()
  assert.deepEqual([opens, status], before)
  assert.equal(connections, 1)
  assert.equal(probes, 0)
  assert.equal(restored.size, 0)
  assert.equal((Reflect.get(events, "handlers") as Map<unknown, unknown>).size, 0)
  assert.equal((Reflect.get(events, "openHandlers") as Set<unknown>).size, 0)
  assert.equal((Reflect.get(events, "statusHandlers") as Set<unknown>).size, 0)
})

test("dispose aborts pending pong IO and an event-owned auth probe", async t => {
  renderer(t)
  let source!: EventSource
  let ping!: (event: { data: string }) => void
  const signals: AbortSignal[] = []
  const client = createBackendClient({ id: "pending_io", baseUrl: "https://pending.invalid",
    eventSource: () => {
      source = { addEventListener(type: string, callback: typeof ping) { if (type === "codenomad.client.ping") ping = callback }, close() {} } as unknown as EventSource
      return source
    },
    fetcher: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init!.signal!
      signals.push(signal)
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    }),
  })
  t.after(() => client.events.dispose())
  client.events.start()
  await tick()
  ping({ data: JSON.stringify({ ts: 1 }) })
  source.onerror!(new Event("error"))
  assert.equal(signals.length, 2)
  client.events.dispose()
  await tick()
  assert.ok(signals.every(signal => signal.aborted))
  assert.equal(client.auth.required(), false)
})

test("backend removal disposes foreground retry ownership before the same id is attached again", async t => {
  renderer(t)
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let refreshes = 0
  createRoot(dispose => {
    t.after(dispose)
    useForegroundRefresh({ onRefresh: async () => { refreshes++; throw new Error("offline") } })
  })
  await tick()
  const a = owner(t, "foreground_removed")
  const detach = backendEvents.attach(a.client.id, a.client.events)
  t.after(detach)
  // Exercise the actual fan-in lifecycle without exposing hook internals.
  const emit = Reflect.get(a.client.events, "emitTransportStatus").bind(a.client.events) as (status: string) => void
  emit("disconnected"); emit("connected")
  await tick()
  assert.equal(refreshes, 1)
  detach()
  t.mock.timers.tick(5000)
  await tick()
  t.after(backendEvents.attach(a.client.id, a.client.events))
  emit("connected")
  await tick()
  assert.equal(refreshes, 1, "reattachment starts clean rather than resuming a removed recovery episode")
})
