import assert from "node:assert/strict"
import { test } from "node:test"
import { format } from "node:util"
import debug from "debug"
import { attachEventSourceHandlers } from "./event-source-handlers"
import { getLogger, enableLogger, disableLogger } from "./logger"
import { serverEvents } from "./server-events"
import { sseManager } from "./sse-manager"

function logging(t: any) {
  const logger = getLogger("sse"), rendered: string[] = [], warnings: unknown[][] = [], errors: unknown[][] = []
  const originalLog = debug.log, originalWarn = logger.warn, originalError = logger.error
  debug.log = (...args: unknown[]) => { rendered.push(format(...args)) }
  logger.warn = (...args: unknown[]) => { warnings.push(args); originalWarn(...args) }
  logger.error = (...args: unknown[]) => { errors.push(args); originalError(...args) }
  enableLogger("sse")
  t.after(() => { debug.log = originalLog; logger.warn = originalWarn; logger.error = originalError; disableLogger("sse") })
  return { logger, rendered, warnings, errors }
}

for (const field of ["answer", "message"]) test(`invalid SSE JSON keeps ${field} outside actual logger; next valid input delivers once`, t => {
  const h = logging(t), sentinel = "F3SECRET", delivered: unknown[] = [], listeners = new Map<string, any>()
  const source = { addEventListener: (name: string, handler: any) => listeners.set(name, handler) } as unknown as EventSource
  attachEventSourceHandlers(source, { logger: h.logger, onEvent: event => delivered.push(event) })
  source.onmessage!({ data: `{"${field}":${sentinel}}` } as MessageEvent)
  assert.equal(h.errors.length, 1)
  assert.equal(delivered.length, 0)
  listeners.get("codenomad.client.ping")({ data: `{"${field}":${sentinel}}` })
  assert.equal(h.errors.length, 2)
  source.onmessage!({ data: JSON.stringify({ type: "workspace.stopped", workspaceId: "synthetic", reason: "deleted" }) } as MessageEvent)
  assert.equal(delivered.length, 1)
  assert(h.rendered.some(line => line.includes("Failed to parse event")))
  assert.equal(JSON.stringify(h.errors).includes(sentinel), false)
  assert.equal(h.rendered.some(line => line.includes(sentinel)), false)
})

test("SSE dispatch/subscriber exceptions stay structural and do not replay or stop later delivery", t => {
  const h = logging(t), sentinel = "synthetic-answer-permission-content", delivered: unknown[] = []
  const transport = { addEventListener() {} } as unknown as EventSource
  attachEventSourceHandlers(transport, { logger: h.logger, onEvent: () => { throw new Error(sentinel) } })
  transport.onmessage!({ data: JSON.stringify({ type: "workspace.stopped" }) } as MessageEvent)
  const stop = serverEvents.on("workspace.stopped", () => { throw new Error(sentinel) })
  const observe = serverEvents.on("workspace.stopped", event => delivered.push(event))
  t.after(() => { stop(); observe() })
  attachEventSourceHandlers(transport, { logger: h.logger, onEvent: event => (serverEvents as any).dispatchBatch([event]) })
  transport.onmessage!({ data: JSON.stringify({ type: "workspace.stopped", workspaceId: "synthetic", reason: "deleted" }) } as MessageEvent)
  assert.equal(h.errors.length, 2)
  assert.equal(delivered.length, 1)
  assert(h.rendered.some(line => line.includes("Failed to dispatch event")))
  assert(h.rendered.some(line => line.includes("Backend event subscriber failed")))
  assert.equal(JSON.stringify(h.errors).includes(sentinel), false)
  assert.equal(h.rendered.some(line => line.includes(sentinel)), false)
})

for (const kind of ["answer", "permission"] as const) for (const malformed of ["missing", "nonstring", "valid"] as const) {
  test(`native SSE ${kind}/${malformed} uses structural fallback and retains valid delivery`, t => {
    const h = logging(t), instanceId = `fallback-${kind}-${malformed}`, serverId = "synthetic-F3-server"
    const source = { serverId, generation: 7, connectionGeneration: 42 }, liveGeneration = 70
    const sentinel = `synthetic-F3-${kind}-payload-${malformed}`, delivered: unknown[] = []
    const originalForm = sseManager.onNativeSessionEvent, originalPermission = sseManager.onPermissionUpdated
    serverEvents.setBindingReader(id => id === instanceId ? serverId : undefined)
    sseManager.onNativeSessionEvent = (_id, event) => delivered.push(event)
    sseManager.onPermissionUpdated = (_id, event) => delivered.push(event)
    t.after(() => {
      serverEvents.setBindingReader(() => undefined)
      sseManager.onNativeSessionEvent = originalForm; sseManager.onPermissionUpdated = originalPermission
    })
    const transport = { addEventListener() {} } as unknown as EventSource
    attachEventSourceHandlers(transport, { logger: h.logger, onEvent: event => (serverEvents as any).dispatchBatch([event]) })
    const send = (event: unknown) => transport.onmessage!({ data: JSON.stringify(event) } as MessageEvent)
    send({ type: "instance.eventStatus", instanceId, source, liveGeneration, status: "connected" })
    const data = kind === "answer" ? { id: "synthetic-form", sessionID: "global", answer: { token: sentinel } }
      : { id: "synthetic-permission", sessionID: "synthetic-session", message: sentinel }
    const event = { ...(malformed === "missing" ? {} : { type: malformed === "nonstring" ? 42 : kind === "answer" ? "form.replied" : "permission.asked" }), data }
    const frame = { type: "instance.event", instanceId, source, liveGeneration, event }
    assert.equal(serverEvents.captureEventContext(frame as any).current(), true)
    send(frame)
    assert.equal(delivered.length, malformed === "valid" ? 1 : 0)
    assert.equal(h.warnings.length, malformed === "valid" ? 0 : 1)
    if (malformed !== "valid") {
      assert.equal(h.warnings[0][0], "Dropping malformed event")
      send({ ...frame, event: { ...event, type: kind === "answer" ? "form.replied" : "permission.asked" } })
      assert.equal(delivered.length, 1, "positive after rejected payload delivers once")
    }
    assert(h.rendered.some(line => line.includes("Received event")))
    assert.equal(JSON.stringify(h.warnings).includes(sentinel), false)
    assert.equal(h.rendered.some(line => line.includes(sentinel)), false)
  })
}
