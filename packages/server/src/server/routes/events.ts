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
const BACKPRESSURE_BUFFER_LIMIT_BYTES = 8 * 1024 * 1024

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
    const lastEventCursor = readLastEventCursor(request.headers["last-event-id"])
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
    let bootstrapFrames: string[] | undefined = lastEventCursor === undefined ? [] : undefined
    const pendingWrites: string[] = []
    let pendingWriteBytes = 0

    const close = (discardBufferedData = false) => {
      if (closed) return
      closed = true
      if (heartbeat) clearInterval(heartbeat)
      if (backpressureTimeout) clearTimeout(backpressureTimeout)
      if (drainListener) reply.raw.off("drain", drainListener)
      pendingWrites.length = 0
      pendingWriteBytes = 0
      unsubscribe()
      if (discardBufferedData || blocked) reply.raw.destroy()
      else reply.raw.end?.()
      deps.logger.debug({ clientId }, "SSE client disconnected")
    }

    const armBackpressure = () => {
      blocked = true
      drainListener = () => {
        drainListener = undefined
        blocked = false
        if (backpressureTimeout) clearTimeout(backpressureTimeout)
        backpressureTimeout = undefined
        flushPendingWrites()
      }
      reply.raw.once("drain", drainListener)
      backpressureTimeout = setTimeout(() => close(true), BACKPRESSURE_TIMEOUT_MS)
    }

    const flushPendingWrites = () => {
      while (!closed && !blocked && pendingWrites.length > 0) {
        const payload = pendingWrites.shift()!
        pendingWriteBytes -= Buffer.byteLength(payload)
        if (!reply.raw.write(payload)) armBackpressure()
      }
    }

    const write = (payload: string) => {
      if (closed) return
      if (blocked) {
        pendingWrites.push(payload)
        pendingWriteBytes += Buffer.byteLength(payload)
        if (pendingWriteBytes > BACKPRESSURE_BUFFER_LIMIT_BYTES) close(true)
        return
      }
      if (!reply.raw.write(payload)) armBackpressure()
    }

    const send = (event: WorkspaceEventPayload, cursor?: string) => {
      deps.logger.debug({ clientId, type: event.type }, "SSE event dispatched")
      if (deps.logger.isLevelEnabled("trace")) {
        deps.logger.trace({ clientId, event }, "SSE event payload")
      }
      const frame = `${cursor === undefined ? "" : `id: ${cursor}\n`}data: ${JSON.stringify(event)}\n\n`
      if (bootstrapFrames) bootstrapFrames.push(frame)
      else write(frame)
    }

    const sendReplayGap = (gap: EventReplayGap) => {
      deps.logger.debug({ clientId, ...gap }, "SSE replay window missed")
      write(`event: codenomad.replay.reset\nid: ${gap.latestCursor}\ndata: ${JSON.stringify(gap)}\n\n`)
    }

    unsubscribe = deps.eventBus.onEvent(send, lastEventCursor, sendReplayGap)
    if (bootstrapFrames) {
      bootstrapFrames.push(`event: codenomad.replay.cursor\nid: ${deps.eventBus.latestCursor}\ndata: {}\n\n`)
      const bootstrap = bootstrapFrames.join("")
      bootstrapFrames = undefined
      write(bootstrap)
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

function readLastEventCursor(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  return raw && raw.length <= 512 ? raw : undefined
}
