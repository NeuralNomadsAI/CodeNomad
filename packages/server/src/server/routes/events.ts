import { FastifyInstance } from "fastify"
import { EventBus } from "../../events/bus"
import { WorkspaceEventPayload } from "../../api-types"

interface RouteDeps {
  eventBus: EventBus
  registerClient: (cleanup: () => void) => () => void
}

export function registerEventRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get("/api/events", (request, reply) => {
    const origin = request.headers.origin ?? "*"
    reply.raw.setHeader("Access-Control-Allow-Origin", origin)
    reply.raw.setHeader("Access-Control-Allow-Credentials", "true")
    reply.raw.setHeader("Content-Type", "text/event-stream")
    reply.raw.setHeader("Cache-Control", "no-cache")
    reply.raw.setHeader("Connection", "keep-alive")
    reply.raw.flushHeaders?.()
    reply.hijack()

    const send = (event: WorkspaceEventPayload) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
    }

    const unsubscribe = deps.eventBus.onEvent(send)
    const heartbeat = setInterval(() => {
      reply.raw.write(`:hb ${Date.now()}\n\n`)
    }, 15000)

    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      unsubscribe()
      reply.raw.end?.()
    }

    const unregister = deps.registerClient(close)

    const handleClose = () => {
      close()
      unregister()
    }

    request.raw.on("close", handleClose)
    request.raw.on("error", handleClose)
  })
}
