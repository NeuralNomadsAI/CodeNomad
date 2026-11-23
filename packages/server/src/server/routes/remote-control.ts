import fs from "node:fs"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { z } from "zod"
import { REMOTE_CONTROL_DISABLED, type RemoteControlManager } from "../../remote-control/manager"
import { deviceCookie, PAIR_EXCHANGE_PATH, PAIR_PAGE_PATH } from "../../remote-control/gate"
import { verifiedDirectEntryOrigin, verifiedDirectHttpsOrigin, verifiedDirectServerOrigin } from "../../remote-control/direct-https"
import { isLocalRequest, isRemoteRequest, isRemoteSocket } from "../../remote-control/request-origin"
import { SERVER_PAIR_PATH, validServerPairRequest } from "../../remote-control/server-pairing"

interface RouteDeps {
  manager: RemoteControlManager
}

const DeviceParams = z.object({ id: z.string().uuid() })
const PairBody = z.object({ code: z.string().min(1).max(256) })
const PairingBody = z.object({ origin: z.string().min(1).max(2048) }).strict()
const ServerPairBody = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{32}$/), hostName: z.string().trim().min(1).max(255) }).strict()
const PreviewsBody = z.object({ enabled: z.boolean() })
const PAIR_TEMPLATE_URL = new URL("./auth-pages/remote-pair.html", import.meta.url)
let pairTemplate: string | null = null

export function registerRemoteControlRoutes(app: FastifyInstance, deps: RouteDeps) {
  // One failure bucket per backend, independent of untrusted peer/forwarded metadata.
  let failedAttempts = 0
  let resetsAt = 0
  /** Counts a failed exchange; true once it replied 429. */
  const rateLimited = (reply: FastifyReply): boolean => {
    const now = Date.now()
    if (now >= resetsAt) { failedAttempts = 0; resetsAt = now + 60_000 }
    if (++failedAttempts <= 10) return false
    reply.header("Retry-After", String(Math.max(1, Math.ceil((resetsAt - now) / 1000)))).code(429).send({ error: "Pairing rate limited" })
    return true
  }
  // Browser pairing answers on the tunnel origin and on verified direct HTTPS origins only.
  const directOrigin = (request: FastifyRequest) => verifiedDirectHttpsOrigin(request, deps.manager.directHttpsOrigins?.() ?? [])

  app.post(SERVER_PAIR_PATH, { bodyLimit: 4096, config: { cors: false } }, async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    const origin = verifiedDirectServerOrigin(request, deps.manager.directHttpsOrigins?.() ?? [])
    if (!origin && !isRemoteSocket(request.raw.socket)) return reply.code(404).send({ error: "Not found" })
    if (!validServerPairRequest(request)) return reply.code(403).send({ error: "Server pairing request rejected" })
    const parsed = ServerPairBody.safeParse(request.body)
    // The 192-bit code is checked and consumed atomically before throttling failures;
    // unauthenticated guesses must never lock out a holder of the valid code.
    const paired = !parsed.success ? null : origin
      ? deps.manager.exchangeDirectPairing(parsed.data.code, origin, undefined, parsed.data.hostName)
      : deps.manager.exchangePairing(parsed.data.code, undefined, parsed.data.hostName)
    if (paired) return { device: paired.device, credential: paired.token }
    if (rateLimited(reply)) return reply
    if (!parsed.success) return reply.code(400).send({ error: "Invalid server pairing body" })
    return reply.code(401).send({ error: "This pairing link is invalid, already used or expired" })
  })

  app.get("/api/remote-control/status", async (request) => {
    const { directOrigins, ...status } = deps.manager.status()
    return !isLocalRequest(request) ? { ...status, manageable: false } : { ...status, ...(directOrigins ? { directOrigins } : {}) }
  })

  app.post("/api/remote-control/start", async (request, reply) => {
    if (!requireLocalControl(request, reply) || !requireAllowed(deps, reply)) return
    try {
      return await deps.manager.start()
    } catch (error) {
      reply.code(502)
      return { error: error instanceof Error ? error.message : "Remote Control failed to start" }
    }
  })

  app.post("/api/remote-control/pairings", { bodyLimit: 4096 }, async (request, reply) => {
    if (!requireLocalControl(request, reply) || !requireAllowed(deps, reply)) return
    // Without a body, a tunnel link; with an origin, a link for that verified direct HTTPS origin.
    const parsed = request.body === undefined || request.body === null ? null : PairingBody.safeParse(request.body)
    if (parsed && !parsed.success) {
      reply.code(400)
      return { error: parsed.error.message }
    }
    try {
      return parsed ? deps.manager.createDirectPairing(parsed.data.origin) : deps.manager.createPairing()
    } catch (error) {
      reply.code(409)
      return { error: error instanceof Error ? error.message : "Pairing link creation failed" }
    }
  })

  app.delete("/api/remote-control", async (request, reply) => {
    if (!requireLocalControl(request, reply)) return
    return deps.manager.stop()
  })

  app.put("/api/remote-control/previews", async (request, reply) => {
    if (!requireLocalControl(request, reply)) return
    const parsed = PreviewsBody.safeParse(request.body)
    if (!parsed.success) {
      reply.code(400)
      return { error: parsed.error.message }
    }
    return deps.manager.setPreviewsAllowed(parsed.data.enabled)
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

  app.get(PAIR_PAGE_PATH, async (request, reply) => {
    if (!isRemoteSocket(request.raw.socket) && !verifiedDirectEntryOrigin(request, deps.manager.directHttpsOrigins?.() ?? [])) {
      return reply.code(404).send({ error: "Not found" })
    }
    pairTemplate ??= fs.readFileSync(PAIR_TEMPLATE_URL, "utf-8")
    reply.header("Cache-Control", "no-store")
    reply.header("Referrer-Policy", "no-referrer")
    reply.header("X-Frame-Options", "DENY")
    reply.type("text/html").send(pairTemplate)
  })

  app.post(PAIR_EXCHANGE_PATH, { bodyLimit: 4096 }, async (request, reply) => {
    const ingress = isRemoteSocket(request.raw.socket)
    // A direct exchange needs its own verified https Origin: the code never redeems over another channel.
    const origin = ingress ? null : directOrigin(request)
    if (!ingress && !origin) return reply.code(404).send({ error: "Not found" })
    const parsed = PairBody.safeParse(request.body)
    const userAgent = request.headers["user-agent"]
    const paired = !parsed.success ? null
      : origin ? deps.manager.exchangeDirectPairing(parsed.data.code, origin, userAgent)
      : deps.manager.exchangePairing(parsed.data.code, userAgent)
    if (!paired) {
      if (origin && rateLimited(reply)) return reply
      reply.code(401)
      return { error: "This pairing link is invalid, already used or expired" }
    }
    reply.header("Set-Cookie", deviceCookie(paired.token))
    reply.header("Cache-Control", "no-store")
    return { device: paired.device }
  })
}

function requireAllowed(deps: RouteDeps, reply: FastifyReply): boolean {
  if (!deps.manager.status().disabledByAdministrator) return true
  reply.code(403).send({ error: REMOTE_CONTROL_DISABLED, code: "remote_control_disabled" })
  return false
}

function requireLocalControl(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!isLocalRequest(request)) {
    reply.code(403).send({ error: "Remote Control settings are available on the host only" })
    return false
  }
  return true
}
