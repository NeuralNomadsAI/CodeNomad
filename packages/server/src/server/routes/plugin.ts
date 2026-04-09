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

const SessionTitleUpdateSchema = z.object({
  sessionID: z.string().trim().min(1),
  directory: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1),
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
    deps.voiceModeManager.setEnabled(
      request.params.id,
      { clientId: payload.clientId, connectionId: payload.connectionId },
      payload.enabled,
    )
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

    if (normalized === "session/title" && request.method === "POST") {
      const parsed = SessionTitleUpdateSchema.parse(request.body ?? {})
      const port = deps.workspaceManager.getInstancePort(workspaceId)
      if (!port) {
        reply.code(502).send({ error: "Workspace instance is not ready" })
        return
      }

      const params = new URLSearchParams()
      if (parsed.directory) {
        params.set("directory", parsed.directory)
      }

      const targetUrl = `http://127.0.0.1:${port}/session/${encodeURIComponent(parsed.sessionID)}${params.size > 0 ? `?${params.toString()}` : ""}`
      const headers: Record<string, string> = {
        "content-type": "application/json",
      }

      const authorization = deps.workspaceManager.getInstanceAuthorizationHeader(workspaceId)
      if (authorization) {
        headers.authorization = authorization
      }

      const response = await fetch(targetUrl, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ title: parsed.title }),
      })

      if (!response.ok) {
        const message = await response.text().catch(() => "")
        reply.code(response.status).send({ error: message || `Session update failed with ${response.status}` })
        return
      }

      const payload = (await response.json().catch(() => null)) as { id?: string; title?: string } | null
      reply.send({
        sessionID: payload?.id ?? parsed.sessionID,
        title: payload?.title ?? parsed.title,
      })
      return
    }

    reply.code(404).send({ error: "Unknown plugin endpoint" })
  }

  app.all("/workspaces/:id/plugin/*", handleWildcard)
  app.all("/workspaces/:id/plugin", handleWildcard)
}
