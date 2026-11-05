import assert from "node:assert/strict"
import { test } from "node:test"
import type { WorkspaceEventPayload } from "../../../server/src/api-types"
import { ServerEvents } from "./server-events"

test("actual dispatcher fences all subscribers before wildcard and typed delivery", () => {
  const events = new ServerEvents()
  const binding = new Map([["a", "A"], ["b", "B"], ["local", "local-shared"]])
  events.setBindingReader(id => binding.get(id))
  const wildcard: WorkspaceEventPayload[] = [], typed: WorkspaceEventPayload[] = []
  events.on("*", value => wildcard.push(value))
  events.on("instance.event", value => typed.push(value))
  const send = (value: unknown) => (events as unknown as { dispatchBatch(events: unknown[]): void }).dispatchBatch([value])
  let nextBoundary = 1000
  const boundaries = new Map<number, number>()
  const boundary = (relay: number) => {
    if (!boundaries.has(relay)) boundaries.set(relay, ++nextBoundary)
    return boundaries.get(relay)!
  }
  const status = (instanceId: string, serverId: string, generation: number) => ({
    type: "instance.eventStatus", instanceId, status: "connected", generation, source: { serverId, generation, connectionGeneration: 42 }, liveGeneration: boundary(generation),
  })
  const business = (instanceId: string, serverId?: string, generation = 1) => ({
    type: "instance.event", instanceId, event: { type: "model.updated", data: {} },
    ...(serverId ? { source: { serverId, generation, connectionGeneration: 42 }, liveGeneration: boundary(generation) } : {}),
  })
  send(business("a", "A", 9)) // business cannot establish generation
  send(business("a"))
  send(status("a", "B", 9)) // wrong binding cannot establish a neighbour
  assert.equal(wildcard.length, 0)
  send(status("a", "A", 2))
  send(status("b", "B", 1))
  send(business("a", "A", 2))
  send(business("b", "B", 1))
  send(status("a", "A", 3))
  send(status("a", "A", 2)) // old status cannot roll A back
  send(business("a", "A", 2))
  send(business("a", "A", 4)) // nor can business advance it
  send(business("a", "A", 3))
  send(business("b", "B", 1)) // reset A leaves B unchanged
  send(business("local")) // legacy local compatibility
  send(business("a", "local-shared", 3))
  assert.equal(typed.length, 5)
  assert.equal(wildcard.length, 8)
  assert.deepEqual(typed.map(value => (value as any).instanceId), ["a", "b", "a", "b", "local"])
})

test("a status preceding occurrence hydration waits for its exact binding, then establishes the first generation", () => {
  const events = new ServerEvents(), bindings = new Map<string, string>()
  events.setBindingReader(id => bindings.get(id))
  const received: WorkspaceEventPayload[] = []
  events.on("*", value => received.push(value))
  const send = (value: unknown) => (events as unknown as { dispatchBatch(events: unknown[]): void }).dispatchBatch([value])
  const source = { serverId: "A", generation: 7, connectionGeneration: 42 }, liveGeneration = 100
  send({ type: "instance.eventStatus", instanceId: "a", status: "connected", generation: 7, source, liveGeneration })
  send({ type: "instance.event", instanceId: "a", source, liveGeneration, event: { type: "model.updated", data: {} } })
  assert.equal(received.length, 0)
  bindings.set("a", "A")
  events.syncInstanceBinding("a")
  send({ type: "instance.event", instanceId: "a", source, liveGeneration, event: { type: "model.updated", data: {} } })
  assert.deepEqual(received.map(value => value.type), ["instance.eventStatus", "instance.event"])
})

test("explicit missing or malformed correlation cannot establish a handshake or deliver a business frame", () => {
  const events = new ServerEvents(), received: WorkspaceEventPayload[] = []
  events.setBindingReader(() => "A")
  events.on("*", value => received.push(value))
  const send = (value: unknown) => (events as any).dispatchBatch([value])
  for (const connectionGeneration of [undefined, 0, -1, 1.5, NaN, "42"]) send({ type: "instance.eventStatus", instanceId: "a", status: "connected",
    source: { serverId: "A", generation: 1000, connectionGeneration }, liveGeneration: 70 })
  for (const liveGeneration of [undefined, 0, -1, 1.5, NaN, "70"]) send({ type: "instance.eventStatus", instanceId: "a", status: "connected",
    source: { serverId: "A", generation: 1000, connectionGeneration: 42 }, liveGeneration })
  assert.equal(received.length, 0)
  const source = { serverId: "A", generation: 1000, connectionGeneration: 42 }
  send({ type: "instance.eventStatus", instanceId: "a", status: "connected", source, liveGeneration: 70 })
  send({ type: "instance.event", instanceId: "a", source: { ...source, connectionGeneration: 41 }, liveGeneration: 70, event: { type: "model.updated", data: {} } })
  send({ type: "instance.event", instanceId: "a", source, event: { type: "model.updated", data: {} } })
  assert.equal(received.length, 1)
})

test("same-attempt ownership pulse accepts fresh correlation while old status replay and callbacks remain retired", () => {
  const events = new ServerEvents(), statuses: any[] = []
  events.setBindingReader(() => "A")
  events.on("instance.eventStatus", value => statuses.push(value))
  const source = { serverId: "A", generation: 1000, connectionGeneration: 42 }
  const send = (value: unknown) => (events as any).dispatchBatch([value])
  const status = (state: string, liveGeneration: number) => ({ type: "instance.eventStatus", instanceId: "a", status: state, source, liveGeneration })
  send(status("connected", 70))
  const old = events.captureEventContext({ type: "instance.event", instanceId: "a", source, liveGeneration: 70, event: {} as any })
  send(status("error", 71)); send(status("connected", 72)); send(status("connected", 70))
  assert.deepEqual(statuses.map(frame => frame.liveGeneration), [70, 71, 72])
  assert.equal(old.current(), false)
  assert.equal(events.captureEventContext({ type: "instance.event", instanceId: "a", source, liveGeneration: 72, event: {} as any }).current(), true)
})

test("deferred hydration rejects a contradictory status or connection at the same boundary", () => {
  for (const connectionGeneration of [42, 43]) {
    const events = new ServerEvents(), bindings = new Map<string, string>(), received: any[] = []
    events.setBindingReader(id => bindings.get(id))
    events.on("*", value => received.push(value))
    const send = (value: unknown) => (events as any).dispatchBatch([value])
    const source = { serverId: "A", generation: 1000, connectionGeneration: 42 }
    send({ type: "instance.eventStatus", instanceId: "a", status: "error", source, liveGeneration: 70 })
    send({ type: "instance.eventStatus", instanceId: "a", status: "connected", source: { ...source, connectionGeneration }, liveGeneration: 70 })
    bindings.set("a", "A"); events.syncInstanceBinding("a")
    assert.deepEqual(received.map(frame => frame.status), ["error"])
    assert.equal(events.captureEventContext({ type: "instance.event", instanceId: "a", source, liveGeneration: 70, event: {} as any }).current(), false)
  }
})
