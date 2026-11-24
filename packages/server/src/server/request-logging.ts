import type { FastifyInstance, FastifyRequest } from "fastify"
import type { Logger } from "../logger"
import { isHumanAnswerProofPayload } from "../missions/human-answer"
import { isRecurrenceProofPayload } from "../missions/recurrence-control-proof"
/** Request diagnostics contain only static route templates and completion metadata. */
export function registerRequestLogging(app: FastifyInstance, apiLogger: Logger) {
  const starts = new WeakMap<FastifyRequest, bigint>()
  app.addHook("onRequest", (request, _reply, done) => {
    starts.set(request, process.hrtime.bigint())
    done()
  })
  app.addHook("onResponse", (request, reply, done) => {
    const start = starts.get(request)
    const durationMs = start === undefined ? undefined : Number((process.hrtime.bigint() - start) / BigInt(1_000_000))
    const route = request.routeOptions.url
    const url = !route ? "<unmatched>" : route === "*" || route === "/*" ? "<catchall>" : route
    const base = { method: request.method, url, status: reply.statusCode, durationMs }
    apiLogger.debug(base, "HTTP request completed")
    if (apiLogger.isLevelEnabled("trace")) {
      apiLogger.trace(base, "HTTP request payload")
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
    /(authorization|authority|proof|cookie|credential|key|code|token|password|secret|principal|pairingLink)/i.test(key) ? "<redacted>" : redactSecrets(entry),
  ]))
}
