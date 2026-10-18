import { FastifyInstance } from "fastify"
import { z } from "zod"
import { EventBus } from "../../events/bus"
import { WorkspaceEventPayload } from "../../api-types"
import type { ClientConnectionManager } from "../../clients/connection-manager"
import { Logger } from "../../logger"

interface RouteDeps {
  eventBus: EventBus
  registerClient: (cleanup: () => void) => () => void
  logger: Logger
  connectionManager: ClientConnectionManager
  backpressureLimitBytes?: number
  backpressureTimeoutMs?: number
}

let nextClientId = 0

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
    deps.logger.debug({ clientId }, "SSE client connected")

    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if ((name === "vary" || name.startsWith("access-control-")) && value !== undefined) {
        reply.raw.setHeader(name, value)
      }
    }
    reply.raw.setHeader("Content-Type", "text/event-stream")
    reply.raw.setHeader("Cache-Control", "no-cache")
    reply.raw.setHeader("Connection", "keep-alive")
    reply.raw.flushHeaders?.()
    reply.hijack()

    let unsubscribe = () => {}
    let unregister = () => {}
    let unregisterConnection = () => {}
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let drainTimeout: ReturnType<typeof setTimeout> | undefined
    let closed = false
    let cleaned = false
    let backpressured = false
    let bufferedBytes = 0
    const pending: Array<{ payload: string; bytes: number }> = []
    const backpressureLimitBytes = Math.max(1, deps.backpressureLimitBytes ?? 1024 * 1024)
    const backpressureTimeoutMs = Math.max(1, deps.backpressureTimeoutMs ?? 10_000)
    const clearDrain = () => {
      reply.raw.off("drain", handleDrain)
      if (drainTimeout) clearTimeout(drainTimeout)
      drainTimeout = undefined
    }
    const close = (force = false) => {
      if (closed) return
      closed = true
      if (heartbeat) clearInterval(heartbeat)
      clearDrain()
      pending.length = 0
      bufferedBytes = 0
      unsubscribe()
      if (force) reply.raw.destroy()
      else reply.raw.end?.()
      deps.logger.debug({ clientId }, "SSE client disconnected")
    }
    const handleClose = (force = false) => {
      if (cleaned) return
      cleaned = true
      close(force)
      unregister()
      unregisterConnection()
    }
    const waitForDrain = () => {
      backpressured = true
      reply.raw.once("drain", handleDrain)
      drainTimeout = setTimeout(() => handleClose(true), backpressureTimeoutMs)
    }
    function handleDrain() {
      if (closed) return
      clearDrain()
      backpressured = false
      bufferedBytes = pending.reduce((total, item) => total + item.bytes, 0)
      while (pending.length) {
        const { payload, bytes } = pending.shift()!
        bufferedBytes -= bytes
        if (!reply.raw.write(payload)) waitForDrain()
        if (backpressured) return
      }
      bufferedBytes = 0
    }
    const write = (payload: string) => {
      if (closed) return
      // A single oversized frame (a native message part can embed a base64
      // image) is legal: written directly it is paced by drain, and while
      // backpressured the largest queued frame is exempt from the backlog
      // limit. The drain timeout disconnects a client that never consumes
      // it; only a sustained queued backlog abandons the stream here.
      if (backpressured) {
        const bytes = Buffer.byteLength(payload)
        pending.push({ payload, bytes })
        bufferedBytes += bytes
        const largest = pending.reduce((max, item) => Math.max(max, item.bytes), 0)
        if (bufferedBytes - largest > backpressureLimitBytes) handleClose(true)
        return
      }
      if (!reply.raw.write(payload)) {
        // The frame above was handed to the socket; only queued frames count.
        bufferedBytes = 0
        waitForDrain()
      }
    }
    const send = (event: WorkspaceEventPayload) => {
      deps.logger.debug({ clientId, type: event.type }, "SSE event dispatched")
      if (deps.logger.isLevelEnabled("trace")) {
        deps.logger.trace({ clientId, event }, "SSE event payload")
      }
      write(`data: ${JSON.stringify(event)}\n\n`)
    }

    unsubscribe = deps.eventBus.onEvent(send)
    if (closed) {
      unsubscribe()
      return
    }
    heartbeat = setInterval(() => {
      const ping = { ts: Date.now() }
      write(`event: codenomad.client.ping\ndata: ${JSON.stringify(ping)}\n\n`)
    }, 15000)

    unregister = deps.registerClient(close)
    unregisterConnection = deps.connectionManager.register({
      ...connection,
      close,
    })

    request.raw.on("close", () => handleClose())
    request.raw.on("error", () => handleClose())
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
