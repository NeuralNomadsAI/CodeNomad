import type { FastifyInstance, FastifyRequest } from "fastify"
import type { AuthManager } from "../../auth/manager"
import type { SettingsService } from "../../settings/service"
import type { OpenCodeServerConnections } from "../../opencode/servers/connections"
import { ServerConnectionError } from "../../opencode/servers/connections"
import { initialServerCapabilities } from "../../opencode/servers/capabilities"
import { parseProbeCandidate, ServerProbeError } from "../../opencode/servers/probe"
import { ExplicitEndpointError } from "../../opencode/servers/endpoint"
import { SERVER_CONNECTION_LIMITS } from "../../opencode/servers/types"
import { isLocalRequest } from "../../remote-control/request-origin"
import { requestAdmission } from "../request-admission"
import { routedPath } from "../routed-path"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { normalizeExplicitOrigin } from "../../opencode/servers/origin"
import { OpenCodePairingError, parseOpenCodePairingLink, redeemOpenCodePairing } from "../../opencode/servers/pairing"

const prefix = "/api/opencode-servers"
const privacyPrefix = /^\/api\/opencode-servers(?:[^a-z0-9_-]|$)/i

/** Privacy includes non-routable encoded spellings; authority uses routedPath independently. */
export function isOpenCodeServerAdminTarget(target: string): boolean {
  let path = routedPath(target)
  if (path === null) return true
  // Bound decoding work; still-encoded deep nesting is conservatively private.
  for (let pass = 0; pass < 3; pass++) {
    if (privacyPrefix.test(path)) return true
    if (!path.includes("%")) return false
    try { path = decodeURIComponent(path) } catch { return true }
  }
  return privacyPrefix.test(path) || path.includes("%")
}

const errorCodes = new Set(["unauthorized", "host_only", "invalid_request", "metadata_unavailable", "probe_busy", "closed",
  // prototype-1236: pairing and removal outcomes.
  "invalid_link", "pairing_expired", "unreachable", "https_required", "forbidden_address", "auth", "unknown_server"])

/** Install before the remote gate/body parser, so even early refusals are private. */
export function registerOpenCodeServerAdminPrivacy(app: FastifyInstance) {
  app.addHook("onRequest", (request, reply, done) => {
    if (isOpenCodeServerAdminTarget(request.raw.url ?? request.url)) reply.header("cache-control", "no-store")
    done()
  })
  app.addHook("onSend", (request, reply, payload, done) => {
    if (!isOpenCodeServerAdminTarget(request.raw.url ?? request.url) || reply.statusCode < 400) { done(null, payload); return }
    let code = reply.statusCode === 401 ? "unauthorized" : reply.statusCode === 403 ? "host_only" : "invalid_request"
    try { const value = JSON.parse(String(payload)); if (errorCodes.has(value.code)) code = value.code } catch { /* fixed diagnostic only */ }
    reply.header("content-type", "application/json; charset=utf-8").removeHeader("www-authenticate")
    done(null, JSON.stringify({ error: code, code }))
  })
}

/** Authentication + loopback/non-ingress + actual Origin/Fetch Metadata admission.
 * Native renderers use the ordinary backend origin; loading pages mount no admin readers.
 */
export function registerOpenCodeServerAdminGuard(app: FastifyInstance, deps: {
  auth: AuthManager; selfOrigins(): Set<string>; devOrigins: ReadonlySet<string>; protocol: "http" | "https"
}) {
  app.addHook("onRequest", (request, reply, done) => {
    const path = routedPath(request.raw.url ?? request.url)
    if (path === null || !(path === prefix || path.startsWith(`${prefix}/`))) { done(); return }
    if (!deps.auth.getSessionFromRequest(request)) { reply.code(401).send({ code: "unauthorized" }); return }
    const listener = app.server.address()
    if (!isLocalRequest(request) || !trustedBrowserRequest(request, deps, typeof listener === "object" ? listener?.port : undefined)) { reply.code(403).send({ code: "host_only" }); return }
    done()
  })
}

function trustedBrowserRequest(request: FastifyRequest, deps: { selfOrigins(): Set<string>; devOrigins: ReadonlySet<string>; protocol: string }, listeningPort?: number): boolean {
  const self = deps.selfOrigins(), port = request.raw.socket.localPort ?? listeningPort
  // An ephemeral listener has its real port before public metadata is published.
  if (port) for (const host of ["localhost", "127.0.0.1", "[::1]"]) self.add(`${deps.protocol}://${host}:${port}`)
  if (![...self].some(origin => { try { return new URL(origin).host === request.headers.host } catch { return false } })) return false
  const site = request.headers["sec-fetch-site"]
  const origin = request.headers.origin
  if (site !== undefined && site !== "same-origin" && site !== "none"
    && !((site === "same-site" || site === "cross-site") && typeof origin === "string" && deps.devOrigins.has(origin))) return false
  if (origin === undefined) return true // Authenticated host CLI/native requests have no browser Origin.
  if (typeof origin !== "string") return false
  try {
    const url = new URL(origin)
    if (url.origin !== origin || url.username || url.password || !["http:", "https:"].includes(url.protocol)) return false
  } catch { return false }
  return self.has(origin) || deps.devOrigins.has(origin)
}

// prototype-1236: Add server accepts an `opencode pair` link, or `scheme://user:password@host`
// as the secondary manual form. The answer names the profile only, never a credential.
const AddSchema = z.object({ name: z.string().max(200).optional(), address: z.string().min(1).max(4_096) }).strict()

async function addOpenCodeServer(deps: { settings: SettingsService; connections(): OpenCodeServerConnections },
  body: z.infer<typeof AddSchema>, signal: AbortSignal) {
  const link = parseOpenCodePairingLink(body.address)
  let origin: string, credentials: { username: string; password: string } | undefined, token: string | undefined
  if (link) {
    origin = link.origin
    token = await redeemOpenCodePairing(link, signal)
  } else {
    let url: URL
    try { url = new URL(body.address.trim()) } catch { throw new OpenCodePairingError("invalid_link") }
    if (!url.password || url.search || url.hash || url.pathname !== "/") throw new OpenCodePairingError("invalid_link")
    credentials = { username: decodeURIComponent(url.username) || "opencode", password: decodeURIComponent(url.password) }
    try { origin = normalizeExplicitOrigin(url.origin) } catch (error) {
      throw new OpenCodePairingError(error instanceof ExplicitEndpointError && (error.code === "https_required" || error.code === "forbidden_address") ? error.code : "invalid_link")
    }
    try { await deps.connections().probeCandidate({ origin, credentials }, signal) }
    catch (error) { throw new OpenCodePairingError(error instanceof ServerProbeError && error.code === "auth" ? "pairing_expired" : "unreachable") }
  }
  const registry = deps.settings.getOpenCodeServerRegistry()
  const explicit = registry.list().filter(profile => profile.kind === "explicit")
  const existing = explicit.find(profile => profile.origin === origin)
  const label = body.name?.trim() || existing?.label || new URL(origin).host
  const profile = { kind: "explicit" as const, id: existing?.id ?? `oc-${randomUUID()}`, label, origin }
  registry.replace(existing ? explicit.map(value => value.id === profile.id ? profile : value) : [...explicit, profile])
  const owner = deps.settings.getOpenCodeServerCredentials()
  if (token !== undefined) await owner.setPaired(profile.id, token)
  else await owner.set(profile.id, JSON.stringify(credentials))
  return { id: profile.id, label: profile.label, origin: profile.origin }
}

export function registerOpenCodeServerRoutes(app: FastifyInstance, deps: {
  settings: SettingsService; connections(): OpenCodeServerConnections
}) {
  app.post(`${prefix}/add`, async (request, reply) => {
    const parsed = AddSchema.safeParse(request.body)
    if (!parsed.success || Object.keys(request.query as object).length) return reply.code(400).send({ code: "invalid_request" })
    const observer = requestAdmission(request, reply)
    try { return await addOpenCodeServer(deps, parsed.data, observer.signal) }
    catch (error) {
      if (observer.signal.aborted || reply.raw.destroyed) { reply.hijack(); return }
      return reply.code(error instanceof OpenCodePairingError && error.code !== "unreachable" ? 400 : 502)
        .send({ code: error instanceof OpenCodePairingError ? error.code : "unreachable" })
    } finally { observer.dispose() }
  })
  // prototype-1236: removal disconnects known attachments; the UI closes their tabs.
  app.delete<{ Params: { id: string } }>(`${prefix}/:id`, async (request, reply) => {
    const registry = deps.settings.getOpenCodeServerRegistry()
    const explicit = registry.list().filter(profile => profile.kind === "explicit")
    if (!explicit.some(profile => profile.id === request.params.id)) return reply.code(404).send({ code: "unknown_server" })
    deps.connections().disconnect(request.params.id)
    await deps.settings.getOpenCodeServerCredentials().clear(request.params.id)
    registry.replace(explicit.filter(profile => profile.id !== request.params.id))
    return reply.code(204).send()
  })
  app.get(prefix, async (_request, reply) => {
    try {
      const summaries = await deps.settings.getOpenCodeServerSummaries(), owner = deps.connections()
      return { servers: summaries.map(profile => ({ ...profile, state: owner.administrativeState(profile.id, profile.kind === "explicit" ? profile.origin : undefined) })), limits: {
        explicitActiveTargets: SERVER_CONNECTION_LIMITS.explicitActiveTargets,
        reservedLocalTargets: SERVER_CONNECTION_LIMITS.reservedLocalTargets, activeExplicitTargets: owner.activeExplicitTargets,
      } }
    } catch { return reply.code(503).send({ code: "metadata_unavailable" }) }
  })
  app.post(`${prefix}/probe`, async (request, reply) => {
    let candidate
    try {
      if (Object.keys(request.query as object).length) throw new Error()
      candidate = parseProbeCandidate(request.body)
    } catch { return reply.code(400).send({ code: "invalid_request" }) }
    const observer = requestAdmission(request, reply)
    try {
      const result = await deps.connections().probeCandidate(candidate, observer.signal)
      observer.signal.throwIfAborted()
      return result
    } catch (error) {
      if (observer.signal.aborted || reply.raw.destroyed) { reply.hijack(); return }
      if (error instanceof ServerConnectionError) return reply.code(error.code === "probe_busy" ? 409 : 503).send({ code: error.code === "probe_busy" ? "probe_busy" : "closed" })
      const diagnostic = error instanceof ServerProbeError ? { code: error.code, phase: error.phase }
        : error instanceof ExplicitEndpointError ? { code: error.code, phase: "validation" } : { code: "network", phase: "contract" }
      return { version: null, capabilities: (error instanceof ServerProbeError ? error.capabilities : undefined)
        ?? initialServerCapabilities({ id: "candidate", kind: "explicit", label: "candidate", origin: candidate.origin }, 0).features,
        checkedAt: new Date().toISOString(), diagnostic }
    } finally { observer.dispose() }
  })
}
