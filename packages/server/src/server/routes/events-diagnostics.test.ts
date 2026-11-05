import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { EventBus } from "../../events/bus"
import { registerEventRoutes } from "./events"

for (const sentinel of ["review-answer-sentinel", "review-feedback-sentinel"]) test(`SSE trace retains useful event types without ${sentinel}`, async () => {
  const entries: unknown[] = []
  const logger = { debug() {}, trace: (...args: unknown[]) => entries.push(args), isLevelEnabled: () => true } as any
  const bus = new EventBus(logger), app = Fastify()
  let ready!: () => void, close!: () => void
  const opened = new Promise<void>(resolve => { ready = resolve })
  registerEventRoutes(app, { eventBus: bus, logger, registerClient: callback => { close = callback; ready(); return () => {} },
    connectionManager: { register: () => () => {}, pong: () => false } as any })
  const response = app.inject({ method: "GET", url: "/api/events?clientId=owned&connectionId=owned" })
  await opened
  try {
    bus.publish({ type: "instance.event", instanceId: "owned", source: { serverId: "A", generation: 1 },
      event: { type: "form.replied", data: { id: "form", sessionID: "global", answer: { token: "review-answer-sentinel" } } } } as any)
    bus.publish({ type: "instance.event", instanceId: "owned", source: { serverId: "A", generation: 1 },
      event: { type: "permission.asked", data: { id: "permission", sessionID: "session", message: "review-feedback-sentinel" } } } as any)
  } finally { close(); await response; await app.close() }
  assert.equal(JSON.stringify(entries).includes(sentinel), false)
  assert.deepEqual(entries, [
    [{ clientId: (entries[0] as any[])[0].clientId, type: "instance.event", nativeType: "form.replied" }, "SSE event dispatched"],
    [{ clientId: (entries[1] as any[])[0].clientId, type: "instance.event", nativeType: "permission.asked" }, "SSE event dispatched"],
  ])
  assert.equal(typeof (entries[0] as any[])[0].clientId, "number")
})
