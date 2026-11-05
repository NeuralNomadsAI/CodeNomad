import type { FastifyInstance, FastifyRequest } from "fastify"
import type { Logger } from "../logger"
import { isHumanAnswerProofPayload } from "../missions/human-answer"
import { isRecurrenceProofPayload } from "../missions/recurrence-control-proof"
import { isOpenCodeServerAdminTarget } from "./routes/opencode-servers"
import { isProjectParticipationTarget } from "./routes/project-participation"

const integrationRoute = "/api/workspaces/:id/integrations"
const integrationRoutes = new Set([integrationRoute, "/api/workspaces/:id/plugin-sources", ...["hosts", "binding", "attach", "detach", "install", "install-host"].map(action => `${integrationRoute}/:integrationId/${action}`)])

function integrationLogRoute(request: FastifyRequest): string | undefined {
  const route = request.routeOptions.url
  if (route && integrationRoutes.has(route)) return route
  // Rejects and malformed parameters may have no matched route. Decode segments independently so
  // a bad escape in a caller-owned ID cannot disable the namespace's confidentiality policy.
  const pathname = request.url.split(/[?#]/, 1)[0].replace(/^[a-z]+:\/\/[^/]*/i, "")
  const parts = pathname.replace(/^\/+/, "/").split("/").map(part => {
    try { return decodeURIComponent(part) } catch { return part }
  })
  if (parts[1] === "api" && parts[2] === "workspaces" && parts[4] === "integrations") return `${integrationRoute}/*`
  if (parts[1] === "api" && parts[2] === "workspaces" && parts[4] === "plugin-sources") return "/api/workspaces/:id/plugin-sources/*"
}

/** Integration diagnostics contain only fixed routes and completion metadata, including rejected requests. */
export function registerRequestLogging(app: FastifyInstance, apiLogger: Logger) {
  const starts = new WeakMap<FastifyRequest, bigint>()
  app.addHook("onRequest", (request, _reply, done) => {
    starts.set(request, process.hrtime.bigint())
    done()
  })
  app.addHook("onResponse", (request, reply, done) => {
    const start = starts.get(request)
    const durationMs = start === undefined ? undefined : Number((process.hrtime.bigint() - start) / BigInt(1_000_000))
    const integration = integrationLogRoute(request)
    const privateAdmin = isOpenCodeServerAdminTarget(request.raw.url ?? request.url)
    const privateParticipation = isProjectParticipationTarget(request.raw.url ?? request.url)
    const privatePayload = privateAdmin || privateParticipation
    const base = {
      method: privatePayload && !["GET", "POST", "HEAD", "OPTIONS", "PATCH", "PUT", "DELETE"].includes(request.method) ? "OTHER" : request.method,
      url: privateAdmin ? "/api/opencode-servers/<redacted>" : privateParticipation ? "/api/project-participation/<redacted>" : integration ?? request.url,
      status: reply.statusCode, durationMs,
    }
    apiLogger.debug(base, "HTTP request completed")
    if (apiLogger.isLevelEnabled("trace")) {
      apiLogger.trace(integration || privatePayload ? base : {
        ...base,
        params: redactSecrets(request.params),
        query: redactSecrets(request.query),
        body: typeof request.body === "string" || request.url.startsWith("/api/panel-extensions") ? "<redacted>" : redactSecrets(request.body),
      }, "HTTP request payload")
    }
    done()
  })
}

export function redactSecrets(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map(redactSecrets)
  if (typeof value !== "object") return value
  if (Buffer.isBuffer(value)) return "<redacted>"
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return "<redacted>"
  if (isRecurrenceProofPayload(value as Record<string, unknown>)
    || isHumanAnswerProofPayload(value as Record<string, unknown>)) return "<redacted>"
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    /(authorization|cookie|key|code|token|password|secret|principal)/i.test(key) ? "<redacted>" : redactSecrets(entry),
  ]))
}
