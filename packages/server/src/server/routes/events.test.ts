import assert from "node:assert/strict"
import { test } from "node:test"
import Fastify from "fastify"

import { ClientConnectionManager } from "../../clients/connection-manager"
import { EventBus } from "../../events/bus"
import { registerEventRoutes } from "./events"

test("SSE does not reflect request origins", async () => {
  const app = Fastify({ logger: false })
  registerEventRoutes(app, {
    eventBus: new EventBus(),
    registerClient: (close) => {
      setImmediate(close)
      return () => undefined
    },
    logger: { debug: () => undefined, isLevelEnabled: () => false } as never,
    connectionManager: { register: () => () => undefined } as never,
  })

  const response = await app.inject({
    method: "GET",
    url: "/api/events?clientId=client&connectionId=connection",
    headers: { origin: "https://attacker.example" },
  })

  assert.equal(response.headers["access-control-allow-origin"], undefined)
  assert.equal(response.headers["access-control-allow-credentials"], undefined)
  await app.close()
})

test("SSE acknowledges its initial cursor after bootstrap statuses", async () => {
  const app = Fastify({ logger: false })
  const eventBus = new EventBus(undefined, 1_000, Infinity, "test")
  eventBus.publish({ type: "instance.eventStatus", instanceId: "workspace", status: "connected" })
  app.addHook("onRequest", (_request, reply, done) => {
    const write = reply.raw.write.bind(reply.raw)
    reply.raw.write = ((chunk: unknown, ...args: unknown[]) => {
      const accepted = write(chunk, ...args as [])
      if (!String(chunk).includes("instance.eventStatus")) return accepted
      setImmediate(() => reply.raw.emit("drain"))
      return false
    }) as typeof reply.raw.write
    done()
  })
  registerEventRoutes(app, {
    eventBus,
    registerClient: (close) => {
      setImmediate(close)
      return () => undefined
    },
    logger: { debug: () => undefined, isLevelEnabled: () => false } as never,
    connectionManager: { register: () => () => undefined } as never,
  })

  const response = await app.inject({
    method: "GET",
    url: "/api/events?clientId=client&connectionId=connection",
  })

  assert.ok(response.payload.indexOf("instance.eventStatus") < response.payload.indexOf("codenomad.replay.cursor"))
  assert.match(response.payload, /event: codenomad\.replay\.cursor\nid: test:1\ndata: \{\}\n\n/)
  await app.close()
})

test("SSE resumes queued events after a backpressured frame", async () => {
  const app = Fastify({ logger: false })
  const eventBus = new EventBus()
  let closeClient: (() => void) | undefined
  app.addHook("onRequest", (_request, reply, done) => {
    const write = reply.raw.write.bind(reply.raw)
    reply.raw.write = ((chunk: unknown, ...args: unknown[]) => {
      const accepted = write(chunk, ...args as [])
      if (String(chunk).includes("workflow.run.updated")) {
        setImmediate(() => {
          reply.raw.emit("drain")
          setImmediate(() => closeClient?.())
        })
        return false
      }
      return accepted
    }) as typeof reply.raw.write
    done()
  })
  registerEventRoutes(app, {
    eventBus,
    registerClient: (close) => {
      closeClient = close
      setImmediate(() => {
        eventBus.publish({
          type: "instance.event",
          instanceId: "workspace",
          event: { type: "workflow.run.updated", properties: { run: { snapshot: "large" } } },
        } as never)
        eventBus.publish({
          type: "workspace.log",
          workspaceId: "workspace",
          entry: { sequence: 2 },
        } as never)
      })
      return () => undefined
    },
    logger: { debug: () => undefined, isLevelEnabled: () => false } as never,
    connectionManager: { register: () => () => undefined } as never,
  })

  const response = await app.inject({
    method: "GET",
    url: "/api/events?clientId=client&connectionId=connection",
  }).catch(() => undefined)

  assert.match(response?.payload ?? "", /workflow\.run\.updated/)
  assert.match(response?.payload ?? "", /"sequence":2/)
  assert.equal(eventBus.listenerCount("instance.event"), 0)
  await app.close()
})

test("SSE replays ordered events published behind a backpressured frame", async () => {
  const app = Fastify({ logger: false })
  const eventBus = new EventBus(undefined, 1_000, Infinity, "test")
  let requestCount = 0
  let closeFirstClient: (() => void) | undefined
  app.addHook("onRequest", (_request, reply, done) => {
    requestCount += 1
    if (requestCount === 1) {
      const write = reply.raw.write.bind(reply.raw)
      reply.raw.write = ((chunk: unknown, ...args: unknown[]) => {
        const accepted = write(chunk, ...args as [])
        if (String(chunk).includes('"sequence":1')) {
          setImmediate(() => {
            reply.raw.emit("drain")
            setImmediate(() => closeFirstClient?.())
          })
          return false
        }
        return accepted
      }) as typeof reply.raw.write
    }
    done()
  })
  registerEventRoutes(app, {
    eventBus,
    registerClient: (close) => {
      if (requestCount === 1) {
        closeFirstClient = close
        setImmediate(() => {
          for (const sequence of [1, 2, 3]) {
            eventBus.publish({
              type: "instance.event",
              instanceId: "workspace",
              event: { type: "test.event", properties: { sequence } },
            } as never)
          }
        })
      } else {
        setImmediate(close)
      }
      return () => undefined
    },
    logger: { debug: () => undefined, isLevelEnabled: () => false } as never,
    connectionManager: { register: () => () => undefined } as never,
  })

  await app.inject({
    method: "GET",
    url: "/api/events?clientId=client&connectionId=connection",
  }).catch(() => undefined)
  assert.equal(eventBus.listenerCount("instance.event"), 0)

  const replay = await app.inject({
    method: "GET",
    url: "/api/events?clientId=client&connectionId=connection",
    headers: { "last-event-id": "test:1" },
  })

  assert.deepEqual(
    [...replay.payload.matchAll(/id: (test:\d+)\ndata: .*?"sequence":(\d+)/g)].map((match) => [match[1], Number(match[2])]),
    [["test:2", 2], ["test:3", 3]],
  )
  assert.equal(eventBus.listenerCount("instance.event"), 0)
  await app.close()
})

test("SSE signals an overflow gap before handing off to live events", async () => {
  const app = Fastify({ logger: false })
  const eventBus = new EventBus(undefined, 2, Infinity, "test")
  for (const sequence of [1, 2, 3]) {
    eventBus.publish({
      type: "workspace.log",
      workspaceId: "workspace",
      entry: { sequence },
    } as never)
  }
  registerEventRoutes(app, {
    eventBus,
    registerClient: (close) => {
      setImmediate(() => {
        eventBus.publish({
          type: "workspace.log",
          workspaceId: "workspace",
          entry: { sequence: 4 },
        } as never)
        close()
      })
      return () => undefined
    },
    logger: { debug: () => undefined, isLevelEnabled: () => false } as never,
    connectionManager: { register: () => () => undefined } as never,
  })

  const response = await app.inject({
    method: "GET",
    url: "/api/events?clientId=client&connectionId=connection",
    headers: { "last-event-id": "test:0" },
  })

  assert.match(response.payload, /event: codenomad\.replay\.reset\nid: test:3\ndata: \{"requestedCursor":"test:0","earliestAvailableCursor":"test:2","latestCursor":"test:3"\}/)
  assert.doesNotMatch(response.payload, /"sequence":[23]/)
  assert.ok(response.payload.indexOf("codenomad.replay.reset") < response.payload.indexOf('"sequence":4'))
  await app.close()
})

test("an old SSE cleanup cannot unregister its replacement", () => {
  const manager = new ClientConnectionManager({ debug: () => undefined, warn: () => undefined } as never)
  const connection = { clientId: "client", connectionId: "connection" }
  const unregisterOld = manager.register({ ...connection, close: () => undefined })
  manager.register({ ...connection, close: () => undefined })

  unregisterOld()
  assert.equal(manager.isConnected(connection), true)
  manager.shutdown()
})
