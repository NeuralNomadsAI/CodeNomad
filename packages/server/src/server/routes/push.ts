import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { z } from "zod"
import type { AuthManager } from "../../auth/manager"
import type { RemoteControlManager } from "../../remote-control/manager"
import { isRemoteSocket } from "../../remote-control/request-origin"
import { PushInputError, type PushPrincipal, type PushService } from "../../web-push/service"

interface RouteDeps {
  push: Pick<PushService, "status" | "consent" | "subscribe" | "unsubscribe" | "resolve" | "focus">
  auth: AuthManager
  remoteControl: RemoteControlManager
  httpsOrigin(request: FastifyRequest): string | null
  multiBackend(): boolean
}

const SubscriptionBody = z.object({
  subscription: z.object({
    endpoint: z.string().url().max(4096),
    expirationTime: z.number().nullable().optional(),
    keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(256) }).strict(),
  }).strict(),
  projects: z.array(z.string().min(1).max(256)).max(64),
  preferences: z.object({ v: z.literal(1), needsInput: z.boolean(), sessionDone: z.boolean() }).strict(),
}).strict()
const ConsentBody = z.object({ consent: z.literal(true) }).strict()

export function registerPushRoutes(app: FastifyInstance, deps: RouteDeps) {
  const principalFor = (request: FastifyRequest, reply: FastifyReply): PushPrincipal | null => {
    reply.header("Cache-Control", "no-store")
    if (!deps.multiBackend() || request.headers["x-codenomad-server-request"] !== undefined) {
      reply.code(404).send({ error: "Not found" })
      return null
    }
    const session = deps.auth.getSessionFromRequest(request)
    if (!session) {
      reply.code(401).send({ error: "Authentication required" })
      return null
    }
    if (session.sessionId === "auth-disabled") {
      reply.code(403).send({ error: "Push requires authentication" })
      return null
    }
    const tunnel = isRemoteSocket(request.raw.socket)
    const remote = tunnel ? deps.remoteControl.status() : null
    const origin = tunnel ? remote?.enabled && remote.remoteUrl ? new URL(remote.remoteUrl).origin : null : deps.httpsOrigin(request)
    // Reads also reject foreign provenance; the ingress gate checks mutations.
    const source = request.headers.origin ?? (request.headers.referer ? originOf(request.headers.referer) : undefined)
    if (!origin || tunnel && (request.headers.host !== new URL(origin).host || source !== undefined && source !== origin)) {
      reply.code(403).send({ error: "Push requires HTTPS or Remote Control" })
      return null
    }
    return { id: session.sessionId, channel: tunnel ? "tunnel" : "https", origin }
  }
  const serviceError = (error: unknown, reply: FastifyReply) =>
    error instanceof PushInputError
      ? reply.code(400).send({ error: "Invalid push subscription" })
      : reply.code(503).send({ error: "Push storage unavailable" })
  app.get("/api/push/status", async (request, reply) => {
    const principal = principalFor(request, reply)
    if (principal) {
      try { return deps.push.status(principal) } catch (error) { return serviceError(error, reply) }
    }
  })
  app.put("/api/push/subscription", { bodyLimit: 64 * 1024 }, async (request, reply) => {
    const principal = principalFor(request, reply)
    if (!principal) return
    try {
      const status = deps.push.status(principal)
      if (status.unavailable) return reply.code(503).send({ error: "Push storage unavailable" })
      if (!status.enabled) return reply.code(403).send({ error: "Web Push disabled", code: "web_push_disabled" })
      if (ConsentBody.safeParse(request.body).success) return await deps.push.consent(principal)
      const parsed = SubscriptionBody.safeParse(request.body)
      if (!parsed.success) return reply.code(400).send({ error: "Invalid push subscription" })
      await deps.push.subscribe(principal, parsed.data)
      return deps.push.status(principal)
    } catch (error) { return serviceError(error, reply) }
  })
  app.delete("/api/push/subscription", async (request, reply) => {
    const principal = principalFor(request, reply)
    if (!principal) return
    try {
      await deps.push.unsubscribe(principal)
      return reply.code(204).send()
    } catch (error) { return serviceError(error, reply) }
  })
  app.put("/api/push/focus", { bodyLimit: 8192 }, async (request, reply) => {
    const principal = principalFor(request, reply)
    if (!principal) return
    const parsed = z.object({ endpoint: z.string().url().max(4096), viewId: z.string().min(1).max(128), focused: z.boolean() }).strict().safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "Invalid focus hint" })
    deps.push.focus(principal, parsed.data)
    return reply.code(204).send()
  })
  app.get<{ Params: { token: string } }>("/api/push/routes/:token", async (request, reply) => {
    const principal = principalFor(request, reply)
    if (!principal) return
    try {
      const route = await deps.push.resolve(principal, request.params.token)
      return route ?? reply.code(404).send({ error: "Not found" })
    } catch (error) { return serviceError(error, reply) }
  })
}

function originOf(value: string): string {
  try { return new URL(value).origin } catch { return "" }
}
