import type { FastifyInstance, FastifyRequest } from "fastify"
import { z } from "zod"
import type { RemoteControlManager } from "../../remote-control/manager"

interface RouteDeps {
  manager: RemoteControlManager
}

const DeviceParams = z.object({ id: z.string().uuid() })

export function registerRemoteControlRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get("/api/remote-control/status", async (request, reply) => {
    const status = deps.manager.status()
    return isRemoteControlRequest(request) ? { ...status, manageable: false } : status
  })

  app.post("/api/remote-control/start", async (request, reply) => {
    if (!requireLocalControl(request, reply)) return
    try {
      return await deps.manager.start()
    } catch (error) {
      reply.code(502)
      return { error: error instanceof Error ? error.message : "Remote Control failed to start" }
    }
  })

  app.post("/api/remote-control/pairings", async (request, reply) => {
    if (!requireLocalControl(request, reply)) return
    try {
      return await deps.manager.createPairing()
    } catch (error) {
      reply.code(502)
      return { error: error instanceof Error ? error.message : "Pairing link creation failed" }
    }
  })

  app.delete("/api/remote-control", async (request, reply) => {
    if (!requireLocalControl(request, reply)) return
    return deps.manager.stop()
  })

  app.get("/api/remote-control/devices", async (request, reply) => {
    if (!requireLocalControl(request, reply)) return
    try {
      return { devices: await deps.manager.devices() }
    } catch (error) {
      reply.code(502)
      return { error: error instanceof Error ? error.message : "Could not load remote devices" }
    }
  })

  app.delete("/api/remote-control/devices/:id", async (request, reply) => {
    if (!requireLocalControl(request, reply)) return
    const parsed = DeviceParams.safeParse(request.params)
    if (!parsed.success) {
      reply.code(400)
      return { error: parsed.error.message }
    }
    try {
      await deps.manager.revokeDevice(parsed.data.id)
      reply.code(204).send()
    } catch (error) {
      reply.code(502)
      return { error: error instanceof Error ? error.message : "Could not revoke remote device" }
    }
  })
}

function requireLocalControl(request: FastifyRequest, reply: { code: (status: number) => { send: (body: unknown) => unknown } }): boolean {
  if (isRemoteControlRequest(request)) {
    reply.code(403).send({ error: "Remote Control settings are available on the host only" })
    return false
  }
  return true
}

function isRemoteControlRequest(request: FastifyRequest): boolean {
  return request.headers["x-codenomad-remote-control"] === "1"
}
