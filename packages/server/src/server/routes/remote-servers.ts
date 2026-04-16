import { Agent, fetch } from "undici"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { Logger } from "../../logger"
import type { RemoteServerProbeResponse } from "../../api-types"

interface RouteDeps {
  logger: Logger
}

const ProbeSchema = z.object({
  baseUrl: z.string().min(1),
  skipTlsVerify: z.boolean().optional(),
})

const PROBE_TIMEOUT_MS = 8_000

export function registerRemoteServerRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.post("/api/remote-servers/probe", async (request, reply) => {
    try {
      const body = ProbeSchema.parse(request.body ?? {})
      return await probeRemoteServer(body.baseUrl, Boolean(body.skipTlsVerify))
    } catch (error) {
      deps.logger.warn({ err: error }, "Failed to probe remote server")
      reply.code(400)
      return { error: error instanceof Error ? error.message : "Invalid request" }
    }
  })
}

async function probeRemoteServer(baseUrl: string, skipTlsVerify: boolean): Promise<RemoteServerProbeResponse> {
  const normalizedUrl = normalizeBaseUrl(baseUrl)
  const probeUrl = new URL("./api/auth/status", `${normalizedUrl}/`)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  const dispatcher = skipTlsVerify ? new Agent({ connect: { rejectUnauthorized: false } }) : undefined

  try {
    const response = await fetch(probeUrl, {
      method: "GET",
      dispatcher,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    })

    if (!response.ok) {
      return {
        ok: false,
        reachable: true,
        normalizedUrl,
        skipTlsVerify,
        requiresAuth: false,
        authenticated: false,
        error: `Remote server returned HTTP ${response.status}`,
        errorCode: "http_error",
      }
    }

    const payload = (await response.json()) as { authenticated?: unknown }
    if (typeof payload?.authenticated !== "boolean") {
      return {
        ok: false,
        reachable: true,
        normalizedUrl,
        skipTlsVerify,
        requiresAuth: false,
        authenticated: false,
        error: "Remote server did not return a valid CodeNomad auth response",
        errorCode: "invalid_server",
      }
    }

    return {
      ok: true,
      reachable: true,
      normalizedUrl,
      skipTlsVerify,
      requiresAuth: !payload.authenticated,
      authenticated: payload.authenticated,
    }
  } catch (error) {
    const message = describeProbeError(error)
    return {
      ok: false,
      reachable: false,
      normalizedUrl,
      skipTlsVerify,
      requiresAuth: false,
      authenticated: false,
      error: message.message,
      errorCode: message.code,
    }
  } finally {
    clearTimeout(timeout)
    await dispatcher?.close().catch(() => {})
  }
}

function normalizeBaseUrl(input: string): string {
  const parsed = new URL(input.trim())
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Server URL must use http:// or https://")
  }

  parsed.hash = ""
  parsed.search = ""
  parsed.pathname = parsed.pathname === "/" ? "/" : parsed.pathname.replace(/\/+$/, "") || "/"
  const value = parsed.toString()
  return parsed.pathname === "/" ? value.replace(/\/$/, "") : value.replace(/\/$/, "")
}

function describeProbeError(error: unknown): { code: string; message: string } {
  const chain = unwrapErrorChain(error)
  const detailed =
    chain.find((entry) => {
      const code = (entry?.code ?? "").toString()
      return Boolean(code) && code !== "UND_ERR_RESPONSE_STATUS_CODE"
    }) ?? chain[0]

  const code = (detailed?.code ?? "").toString()
  const exactMessage = detailed?.message?.trim() || chain.find((entry) => entry.message?.trim())?.message?.trim()

  if (code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "SELF_SIGNED_CERT_IN_CHAIN" || code === "CERT_HAS_EXPIRED") {
    return {
      code: "tls_error",
      message: "Certificate check failed while connecting to the remote server.",
    }
  }

  return {
    code:
      code === "ERR_INVALID_URL"
        ? "invalid_url"
        : code === "ECONNREFUSED"
          ? "connection_refused"
          : code === "ENOTFOUND"
            ? "dns_error"
            : code === "UND_ERR_CONNECT_TIMEOUT" || code === "ABORT_ERR"
              ? "timeout"
              : code
                ? code.toLowerCase()
                : "probe_failed",
    message: exactMessage || "Failed to connect to the remote server.",
  }
}

function unwrapErrorChain(error: unknown): Array<{ code?: unknown; message?: string }> {
  const results: Array<{ code?: unknown; message?: string }> = []
  let current: unknown = error
  const seen = new Set<unknown>()

  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current)
    const entry = current as { code?: unknown; message?: string; cause?: unknown }
    results.push({ code: entry.code, message: entry.message })
    current = entry.cause
  }

  if (results.length === 0 && error instanceof Error) {
    results.push({ message: error.message })
  }

  return results
}
