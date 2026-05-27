import { FastifyInstance } from "fastify"
import { z } from "zod"
import type { VoiceModeStateResponse } from "../../api-types"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { EventBus } from "../../events/bus"
import type { Logger } from "../../logger"
import { PluginChannelManager } from "../../plugins/channel"
import { buildPingEvent, handlePluginEvent } from "../../plugins/handlers"
import { VoiceModeManager } from "../../plugins/voice-mode"

interface RouteDeps {
  workspaceManager: WorkspaceManager
  eventBus: EventBus
  logger: Logger
  channel: PluginChannelManager
  voiceModeManager: VoiceModeManager
}

const PluginEventSchema = z.object({
  type: z.string().min(1),
  properties: z.record(z.unknown()).optional(),
})

const VoiceModeStateSchema = z.object({
  enabled: z.boolean(),
  clientId: z.string().trim().min(1),
  connectionId: z.string().trim().min(1),
})

export function registerPluginRoutes(app: FastifyInstance, deps: RouteDeps) {
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

    const registration = deps.channel.register(request.params.id, reply)
    deps.voiceModeManager.syncInstance(request.params.id)

    const heartbeat = setInterval(() => {
      deps.channel.send(request.params.id, buildPingEvent())
    }, 15000)

    const close = () => {
      clearInterval(heartbeat)
      registration.close()
      reply.raw.end?.()
    }

    request.raw.on("close", close)
    request.raw.on("error", close)
  })

  app.post<{ Params: { id: string }; Body: VoiceModeStateResponse }>("/workspaces/:id/plugin/voice-mode", (request, reply) => {
    const workspace = deps.workspaceManager.get(request.params.id)
    if (!workspace) {
      reply.code(404).send({ error: "Workspace not found" })
      return
    }

    const payload = VoiceModeStateSchema.parse(request.body ?? {})
    const applied = deps.voiceModeManager.setEnabled(
      request.params.id,
      { clientId: payload.clientId, connectionId: payload.connectionId },
      payload.enabled,
    )

    if (payload.enabled && !applied) {
      reply.code(409).send({ error: "Client connection not active for voice mode enable" })
      return
    }

    return { enabled: payload.enabled }
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
