import { FastifyInstance } from "fastify"
import { z } from "zod"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { EventBus } from "../../events/bus"
import type { Logger } from "../../logger"
import { PluginChannelManager } from "../../plugins/channel"
import { buildPingEvent, handlePluginEvent } from "../../plugins/handlers"

interface RouteDeps {
  workspaceManager: WorkspaceManager
  eventBus: EventBus
  logger: Logger
}

const PluginEventSchema = z.object({
  type: z.string().min(1),
  properties: z.record(z.unknown()).optional(),
})

export function registerPluginRoutes(app: FastifyInstance, deps: RouteDeps) {
  const channel = new PluginChannelManager(deps.logger.child({ component: "plugin-channel" }))

  app.get<{ Params: { id: string } }>("/workspaces/:id/plugin/events", (request, reply) => {
    const workspace = deps.workspaceManager.get(request.params.id)
    if (!workspace) {
      reply.code(404).send({ error: "Workspace not found" })
      return
    }

    reply.raw.setHeader("Content-Type", "text/event-stream")
    reply.raw.setHeader("Cache-Control", "no-cache")
    reply.raw.setHeader("Connection", "keep-alive")
    reply.raw.flushHeaders?.()
    reply.hijack()

    const registration = channel.register(request.params.id, reply)

    const heartbeat = setInterval(() => {
      channel.send(request.params.id, buildPingEvent())
    }, 15000)

    const close = () => {
      clearInterval(heartbeat)
      registration.close()
      reply.raw.end?.()
    }

    request.raw.on("close", close)
    request.raw.on("error", close)
  })

  const handleWildcard = async (request: any, reply: any) => {
    const workspaceId = request.params.id as string
    const workspace = deps.workspaceManager.get(workspaceId)
    if (!workspace) {
      reply.code(404).send({ error: "Workspace not found" })
      return
    }

    const suffix = (request.params["*"] as string | undefined) ?? ""
    const normalized = suffix.replace(/^\/+/, "")

    if (normalized === "event" && request.method === "POST") {
      const parsed = PluginEventSchema.parse(request.body ?? {})
      handlePluginEvent(workspaceId, parsed, { workspaceManager: deps.workspaceManager, eventBus: deps.eventBus, logger: deps.logger })
      reply.code(204).send()
      return
    }

    reply.code(404).send({ error: "Unknown plugin endpoint" })
  }

  app.all("/workspaces/:id/plugin/*", handleWildcard)
  app.all("/workspaces/:id/plugin", handleWildcard)
}
