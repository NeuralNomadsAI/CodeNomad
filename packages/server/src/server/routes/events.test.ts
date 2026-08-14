import assert from "node:assert/strict"
import { describe, it } from "node:test"
import Fastify from "fastify"
import type { EventBus } from "../../events/bus"
import type { Logger } from "../../logger"
import { registerEventRoutes } from "./events"

const logger = { debug() {}, trace() {}, isLevelEnabled() { return false } } as unknown as Logger

function harness(options: { limit?: number; timeout?: number } = {}) {
  const app = Fastify()
  let listener: ((event: any) => void) | undefined
  let closeClient: (() => void) | undefined
  let raw: NodeJS.EventEmitter | undefined
  let unsubscribed = 0
  let unregistered = 0
  const eventBus = {
    onEvent(next: (event: any) => void) {
      listener = next
      return () => { unsubscribed += 1 }
    },
  } as EventBus
  app.addHook("onRequest", (_request, reply, done) => {
    raw = reply.raw
    const originalWrite = reply.raw.write.bind(reply.raw)
    let first = true
    reply.raw.write = ((...args: Parameters<typeof reply.raw.write>) => {
      const result = originalWrite(...args)
      if (first) {
        first = false
        return false
      }
      return result
    }) as typeof reply.raw.write
    done()
  })
  registerEventRoutes(app, {
    eventBus,
    registerClient: (close) => {
      closeClient = close
      return () => { unregistered += 1 }
    },
    connectionManager: {
      register: () => () => { unregistered += 1 },
      pong: () => false,
    } as never,
    logger,
    backpressureLimitBytes: options.limit,
    backpressureTimeoutMs: options.timeout,
  })
  return {
    app,
    emit(event: any) { assert.ok(listener); listener(event) },
    drain() { assert.ok(raw); raw.emit("drain") },
    close() { assert.ok(closeClient); closeClient() },
    ready: () => Boolean(listener && closeClient),
    counts: () => ({ unsubscribed, unregistered }),
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for SSE route")
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

describe("SSE backpressure", () => {
  it("queues after write(false), flushes on drain, and remains connected", async () => {
    const test = harness()
    try {
      const response = test.app.inject({ method: "GET", url: "/api/events?clientId=client&connectionId=connection" })
      await waitFor(test.ready)
      test.emit({ type: "workspace.stopped", workspaceId: "first", reason: "deleted" })
      test.emit({ type: "workspace.stopped", workspaceId: "second", reason: "deleted" })
      assert.deepEqual(test.counts(), { unsubscribed: 0, unregistered: 0 })
      test.drain()
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.deepEqual(test.counts(), { unsubscribed: 0, unregistered: 0 })
      test.close()
      const result = await response
      assert.match(result.body, /"workspaceId":"first"/)
      assert.match(result.body, /"workspaceId":"second"/)
      assert.deepEqual(test.counts(), { unsubscribed: 1, unregistered: 0 })
    } finally {
      await test.app.close()
    }
  })

  it("disconnects deterministically when drain times out", async () => {
    const test = harness({ timeout: 10 })
    try {
      const response = test.app.inject({ method: "GET", url: "/api/events?clientId=client&connectionId=connection" })
      await waitFor(test.ready)
      test.emit({ type: "workspace.stopped", workspaceId: "first", reason: "deleted" })
      await response.catch(() => undefined)
      assert.deepEqual(test.counts(), { unsubscribed: 1, unregistered: 2 })
    } finally {
      await test.app.close()
    }
  })

  it("disconnects when the bounded pending buffer is exceeded", async () => {
    const test = harness({ limit: 256, timeout: 1_000 })
    try {
      const response = test.app.inject({ method: "GET", url: "/api/events?clientId=client&connectionId=connection" })
      await waitFor(test.ready)
      test.emit({ type: "workspace.stopped", workspaceId: "first", reason: "deleted" })
      test.emit({ type: "workspace.stopped", workspaceId: "x".repeat(512), reason: "deleted" })
      await response.catch(() => undefined)
      assert.deepEqual(test.counts(), { unsubscribed: 1, unregistered: 2 })
    } finally {
      await test.app.close()
    }
  })
})
