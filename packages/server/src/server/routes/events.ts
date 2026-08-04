import { FastifyInstance, type FastifyReply } from "fastify"
import { z } from "zod"
import { EventBus, type EventReplayGap } from "../../events/bus"
import { WorkspaceEventPayload } from "../../api-types"
import type { ClientConnectionManager } from "../../clients/connection-manager"
import { Logger } from "../../logger"

interface RouteDeps {
  eventBus: EventBus
  registerClient: (cleanup: () => void) => () => void
  logger: Logger
  connectionManager: ClientConnectionManager
}

let nextClientId = 0
const BACKPRESSURE_TIMEOUT_MS = 5_000

const ConnectionQuerySchema = z.object({
  clientId: z.string().trim().min(1),
  connectionId: z.string().trim().min(1),
})

const PongBodySchema = ConnectionQuerySchema.extend({
  pingTs: z.number().optional(),
})

export function registerEventRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get("/api/events", (request, reply) => {
    const clientId = ++nextClientId
    const connection = ConnectionQuerySchema.parse(request.query ?? {})
    const lastEventId = parseLastEventId(request.headers["last-event-id"])
    deps.logger.debug({ clientId }, "SSE client connected")

    reply.header("Content-Type", "text/event-stream")
    reply.header("Cache-Control", "no-cache")
    reply.header("Connection", "keep-alive")
    copyReplyHeadersToRaw(reply)
    reply.raw.flushHeaders?.()
    reply.hijack()

    let closed = false
    let blocked = false
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let backpressureTimeout: ReturnType<typeof setTimeout> | undefined
    let drainListener: (() => void) | undefined
    let unsubscribe: () => void = () => undefined

    const close = (discardBufferedData = false) => {
      if (closed) return
      closed = true
      if (heartbeat) clearInterval(heartbeat)
      if (backpressureTimeout) clearTimeout(backpressureTimeout)
      if (drainListener) reply.raw.off("drain", drainListener)
      unsubscribe()
      if (discardBufferedData || blocked) reply.raw.destroy()
      else reply.raw.end?.()
      deps.logger.debug({ clientId }, "SSE client disconnected")
    }

    const write = (payload: string) => {
      if (closed || blocked) return
      if (reply.raw.write(payload)) return
      blocked = true
      drainListener = () => {
        drainListener = undefined
        blocked = false
        close()
      }
      reply.raw.once("drain", drainListener)
      backpressureTimeout = setTimeout(() => close(true), BACKPRESSURE_TIMEOUT_MS)
    }

    const send = (event: WorkspaceEventPayload, id?: number) => {
      deps.logger.debug({ clientId, type: event.type }, "SSE event dispatched")
      if (deps.logger.isLevelEnabled("trace")) {
        deps.logger.trace({ clientId, event }, "SSE event payload")
      }
      write(`${id === undefined ? "" : `id: ${id}\n`}data: ${JSON.stringify(event)}\n\n`)
    }

    const sendReplayGap = (gap: EventReplayGap) => {
      deps.logger.debug({ clientId, ...gap }, "SSE replay window missed")
      write(`event: codenomad.replay.reset\nid: ${gap.latestEventId}\ndata: ${JSON.stringify(gap)}\n\n`)
    }

    unsubscribe = deps.eventBus.onEvent(send, lastEventId, sendReplayGap)
    if (lastEventId === undefined) {
      write(`event: codenomad.replay.cursor\nid: ${deps.eventBus.latestEventId}\ndata: {}\n\n`)
    }
    if (closed) {
      unsubscribe()
      return
    }
    heartbeat = setInterval(() => {
      const ping = { ts: Date.now() }
      write(`event: codenomad.client.ping\ndata: ${JSON.stringify(ping)}\n\n`)
    }, 15000)

    const unregister = deps.registerClient(close)
    const unregisterConnection = deps.connectionManager.register({
      ...connection,
      close,
    })

    const handleClose = () => {
      close()
      unregister()
      unregisterConnection()
    }

    request.raw.on("close", handleClose)
    request.raw.on("error", handleClose)
  })

  app.post("/api/client-connections/pong", (request, reply) => {
    const body = PongBodySchema.parse(request.body ?? {})
    if (!deps.connectionManager.pong(body)) {
      reply.code(404).send({ error: "Client connection not found" })
      return
    }
    reply.code(204).send()
  })
}

function copyReplyHeadersToRaw(reply: FastifyReply): void {
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) reply.raw.setHeader(name, value)
  }
}

function parseLastEventId(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  if (!raw || !/^\d+$/.test(raw)) return undefined
  const id = Number(raw)
  return Number.isSafeInteger(id) ? id : undefined
}
