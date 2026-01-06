import type { FastifyReply } from "fastify"
import type { Logger } from "../logger"

export interface PluginOutboundEvent {
  type: string
  properties?: Record<string, unknown>
}

interface ClientConnection {
  reply: FastifyReply
  workspaceId: string
}

export class PluginChannelManager {
  private readonly clients = new Set<ClientConnection>()

  constructor(private readonly logger: Logger) {}

  register(workspaceId: string, reply: FastifyReply) {
    const connection: ClientConnection = { workspaceId, reply }
    this.clients.add(connection)
    this.logger.debug({ workspaceId }, "Plugin SSE client connected")

    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      this.clients.delete(connection)
      this.logger.debug({ workspaceId }, "Plugin SSE client disconnected")
    }

    return { close }
  }

  send(workspaceId: string, event: PluginOutboundEvent) {
    for (const client of this.clients) {
      if (client.workspaceId !== workspaceId) continue
      this.write(client.reply, event)
    }
  }

  broadcast(event: PluginOutboundEvent) {
    for (const client of this.clients) {
      this.write(client.reply, event)
    }
  }

  private write(reply: FastifyReply, event: PluginOutboundEvent) {
    try {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to write plugin SSE event")
    }
  }
}
