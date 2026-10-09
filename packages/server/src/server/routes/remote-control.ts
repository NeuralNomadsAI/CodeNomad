import fs from "node:fs"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { z } from "zod"
import type { RemoteControlManager } from "../../remote-control/manager"
import { deviceCookie, PAIR_EXCHANGE_PATH, PAIR_PAGE_PATH } from "../../remote-control/gate"
import { isRemoteRequest } from "../../remote-control/request-origin"

interface RouteDeps {
  manager: RemoteControlManager
}

const DeviceParams = z.object({ id: z.string().uuid() })
const PairBody = z.object({ code: z.string().min(1).max(256) })
const PAIR_TEMPLATE_URL = new URL("./auth-pages/remote-pair.html", import.meta.url)
let pairTemplate: string | null = null

export function registerRemoteControlRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get("/api/remote-control/status", async (request) => {
    const status = deps.manager.status()
    return isRemoteRequest(request) ? { ...status, manageable: false } : status
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
      return deps.manager.createPairing()
    } catch (error) {
      reply.code(409)
      return { error: error instanceof Error ? error.message : "Pairing link creation failed" }
    }
  })

  app.delete("/api/remote-control", async (request, reply) => {
    if (!requireLocalControl(request, reply)) return
    return deps.manager.stop()
  })

  app.get("/api/remote-control/devices", async (request, reply) => {
    if (!requireLocalControl(request, reply)) return
    return { devices: deps.manager.devices() }
  })

  app.delete("/api/remote-control/devices/:id", async (request, reply) => {
    if (!requireLocalControl(request, reply)) return
    const parsed = DeviceParams.safeParse(request.params)
    if (!parsed.success) {
      reply.code(400)
      return { error: parsed.error.message }
    }
    if (!deps.manager.revokeDevice(parsed.data.id)) {
      reply.code(404)
      return { error: "Remote device not found" }
    }
    reply.code(204).send()
  })

  // Pairing happens only on the public Remote Control origin.
  app.get(PAIR_PAGE_PATH, async (request, reply) => {
    if (!isRemoteRequest(request)) return reply.code(404).send({ error: "Not found" })
    pairTemplate ??= fs.readFileSync(PAIR_TEMPLATE_URL, "utf-8")
    reply.header("Cache-Control", "no-store")
    reply.header("Referrer-Policy", "no-referrer")
    reply.header("X-Frame-Options", "DENY")
    reply.type("text/html").send(pairTemplate)
  })

  app.post(PAIR_EXCHANGE_PATH, { bodyLimit: 4096 }, async (request, reply) => {
    if (!isRemoteRequest(request)) return reply.code(404).send({ error: "Not found" })
    const parsed = PairBody.safeParse(request.body)
    const paired = parsed.success ? deps.manager.exchangePairing(parsed.data.code, request.headers["user-agent"]) : null
    if (!paired) {
      reply.code(401)
      return { error: "This pairing link is invalid, already used or expired" }
    }
    reply.header("Set-Cookie", deviceCookie(paired.token))
    reply.header("Cache-Control", "no-store")
    return { device: paired.device }
  })
}

function requireLocalControl(request: FastifyRequest, reply: FastifyReply): boolean {
  if (isRemoteRequest(request)) {
    reply.code(403).send({ error: "Remote Control settings are available on the host only" })
    return false
  }
  return true
}
