import type { FastifyInstance, FastifyRequest } from "fastify"
import type { AuthManager } from "../../auth/manager"
import type { RemoteControlManager } from "../../remote-control/manager"
import { isRemoteRequest, remoteDeviceOf } from "../../remote-control/request-origin"
import { PARTICIPATION_HEADER, type ProjectParticipants } from "../../workspaces/project-participants"
import type { WorkspaceManager } from "../../workspaces/manager"
import { routedPath } from "../routed-path"

const path = "/api/project-participation"
export function isProjectParticipationTarget(target: string) {
  let value = routedPath(target)
  if (value === null) return false
  for (let pass = 0; pass < 3; pass++) {
    if (/^\/api\/project-participation(?:[^a-z0-9_-]|$)/i.test(value)) return true
    if (!value.includes("%")) return false
    try { value = decodeURIComponent(value) } catch { return false }
  }
  return /^\/api\/project-participation(?:[^a-z0-9_-]|$)/i.test(value)
}

export function registerProjectParticipationPrivacy(app: FastifyInstance) {
  app.addHook("onRequest", (request, reply, done) => {
    if (isProjectParticipationTarget(request.raw.url ?? request.url)) reply.header("cache-control", "no-store")
    done()
  })
  app.addHook("onSend", (request, reply, payload, done) => {
    if (!isProjectParticipationTarget(request.raw.url ?? request.url) || reply.statusCode < 400) { done(null, payload); return }
    reply.header("content-type", "application/json; charset=utf-8").removeHeader("www-authenticate")
    done(null, JSON.stringify({ code: "participation_unavailable" }))
  })
}
type Deps = { auth: AuthManager; remote: Pick<RemoteControlManager, "isDeviceAuthorized">;
  owner: ProjectParticipants; manager: Pick<WorkspaceManager, "get">;
  selfOrigins(): Set<string>; devOrigins: ReadonlySet<string>; protocol: string }

function principal(request: FastifyRequest, deps: Deps) {
  const session = deps.auth.getSessionFromRequest(request)
  if (!session || session.sessionId === "auth-disabled") return undefined
  if (isRemoteRequest(request)) {
    const device = remoteDeviceOf(request)
    return device && deps.remote.isDeviceAuthorized(device) ? session.sessionId : undefined
  }
  return deps.auth.isAuthEnabled() ? session.sessionId : undefined
}

function trusted(request: FastifyRequest, deps: Deps, port?: number) {
  const remote = isRemoteRequest(request), origins = remote ? new Set([`https://${request.headers.host}`]) : deps.selfOrigins()
  if (!remote && port) for (const host of ["localhost", "127.0.0.1", "[::1]"]) origins.add(`${deps.protocol}://${host}:${port}`)
  if (![...origins].some(origin => { try { return new URL(origin).host === request.headers.host } catch { return false } })) return false
  const origin = request.headers.origin, site = request.headers["sec-fetch-site"]
  const dev = !remote && typeof origin === "string" && deps.devOrigins.has(origin)
  if (site !== undefined && site !== "same-origin" && site !== "none" && !dev) return false
  if (origin === undefined) return request.method === "GET" // EventSource same-origin GET omits Origin.
  return typeof origin === "string" && (origins.has(origin) || dev)
}

/** A publishing capability belongs to this exact authenticated response, never SSE correlation IDs. */
export function registerProjectParticipationRoutes(app: FastifyInstance, deps: Deps) {
  const admissions = new WeakMap<FastifyRequest, ReturnType<ProjectParticipants["admit"]>>()
  app.addHook("onRequest", (request, reply, done) => {
    if (routedPath(request.raw.url ?? request.url) !== path) { done(); return }
    reply.header("cache-control", "no-store")
    const address = app.server.address(), port = request.raw.socket.localPort ?? (typeof address === "object" ? address?.port : undefined)
    const identity = principal(request, deps)
    if (!identity || !trusted(request, deps, port)) { reply.code(403).send({ code: "participation_unavailable" }); return }
    if (request.method !== "POST" || /[?;]/.test(request.raw.url ?? request.url)) { reply.code(400).send({ code: "participation_unavailable" }); return }
    const admitted = deps.owner.admit(request.headers[PARTICIPATION_HEADER], identity)
    if (!admitted) { reply.code(403).send({ code: "participation_unavailable" }); return }
    admissions.set(request, admitted); done()
  })
  app.post(path, { bodyLimit: 1024 * 1024 }, (request, reply) => {
    if (request.raw.aborted || reply.raw.destroyed) return reply.code(409).send({ code: "participation_unavailable" })
    const ok = admissions.get(request)?.publish(request.body, id => {
      const workspace = deps.manager.get(id)
      if (!workspace?.binding) return undefined
      return { serverId: workspace.binding.serverId, directory: workspace.binding.directory, owner: workspace.binding }
    })
    if (!ok) return reply.code(409).send({ code: "participation_unavailable" })
    return reply.code(204).send()
  })
  return {
    open(request: FastifyRequest, transportCurrent: () => boolean) {
      const address = app.server.address(), port = request.raw.socket.localPort ?? (typeof address === "object" ? address?.port : undefined)
      const identity = principal(request, deps)
      if (!identity || !trusted(request, deps, port)) return undefined
      return deps.owner.register(identity, () => transportCurrent() && principal(request, deps) === identity)
    },
  }
}
