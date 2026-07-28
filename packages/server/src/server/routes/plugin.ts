import { FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify"
import { z } from "zod"
import type { VoiceModeStateResponse } from "../../api-types"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { EventBus } from "../../events/bus"
import type { Logger } from "../../logger"
import { PluginChannelManager } from "../../plugins/channel"
import { buildPingEvent, handlePluginEvent } from "../../plugins/handlers"
import { VoiceModeManager } from "../../plugins/voice-mode"
import { sendUnauthorized } from "../../auth/http-auth"

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
    if (!isCanonicalPluginPath(request, request.params.id, "events")) {
      reply.code(404).send({ error: "Unknown plugin endpoint" })
      return
    }
    if (!hasPluginCapability(request, request.params.id, deps)) {
      sendUnauthorized(request, reply)
      return
    }
    const workspace = deps.workspaceManager.get(request.params.id)
    if (!workspace) {
      reply.code(404).send({ error: "Workspace not found" })
      return
    }

    reply.header("Content-Type", "text/event-stream")
    reply.header("Cache-Control", "no-cache")
    reply.header("Connection", "keep-alive")
    copyReplyHeadersToRaw(reply)
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

  app.post<{ Params: { id: string } }>("/workspaces/:id/plugin/event", async (request, reply) => {
    const workspaceId = request.params.id
    if (!isCanonicalPluginPath(request, workspaceId, "event")) {
      reply.code(404).send({ error: "Unknown plugin endpoint" })
      return
    }
    if (!hasPluginCapability(request, workspaceId, deps)) {
      sendUnauthorized(request, reply)
      return
    }
    const workspace = deps.workspaceManager.get(workspaceId)
    if (!workspace) {
      reply.code(404).send({ error: "Workspace not found" })
      return
    }

    const parsed = PluginEventSchema.parse(request.body ?? {})
    handlePluginEvent(workspaceId, parsed, { workspaceManager: deps.workspaceManager, eventBus: deps.eventBus, logger: deps.logger })
    reply.code(204).send()
  })

  app.all("/workspaces/:id/plugin/*", (_request, reply) => reply.code(404).send({ error: "Unknown plugin endpoint" }))
  app.all("/workspaces/:id/plugin", (_request, reply) => reply.code(404).send({ error: "Unknown plugin endpoint" }))
}

function isCanonicalPluginPath(request: FastifyRequest, workspaceId: string, endpoint: string): boolean {
  const pathname = (request.raw.url ?? request.url).split("?")[0]
  return pathname === `/workspaces/${encodeURIComponent(workspaceId)}/plugin/${endpoint}`
}

function hasPluginCapability(request: FastifyRequest, workspaceId: string, deps: RouteDeps): boolean {
  const provided = Array.isArray(request.headers.authorization)
    ? request.headers.authorization[0]
    : request.headers.authorization
  const expected = deps.workspaceManager.getPluginCallbackAuthorizationHeader(workspaceId)
  return Boolean(expected && provided === expected)
}

function copyReplyHeadersToRaw(reply: FastifyReply): void {
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) reply.raw.setHeader(name, value)
  }
}
