import http from "http"
import https from "https"
import { Readable } from "stream"

export type PluginEvent = {
  type: string
  properties?: Record<string, unknown>
}

export type CodeNomadConfig = {
  instanceId: string
  baseUrl: string
}

export function getCodeNomadConfig(): CodeNomadConfig {
  return {
    instanceId: requireEnv("CODENOMAD_INSTANCE_ID"),
    baseUrl: requireEnv("CODENOMAD_BASE_URL"),
  }
}

export function createCodeNomadRequester(config: CodeNomadConfig) {
  const rawBaseUrl = (config.baseUrl ?? "").trim()
  const baseUrl = rawBaseUrl.replace(/\/+$/, "")
  const pluginBase = `${baseUrl}/workspaces/${encodeURIComponent(config.instanceId)}/plugin`
  const authorization = buildInstanceAuthorizationHeader()

  const buildUrl = (path: string) => {
    if (path.startsWith("http://") || path.startsWith("https://")) {
      return path
    }
    const normalized = path.startsWith("/") ? path : `/${path}`
    return `${pluginBase}${normalized}`
  }

  const buildHeaders = (headers: HeadersInit | undefined, hasBody: boolean): Record<string, string> => {
    const output: Record<string, string> = normalizeHeaders(headers)
    output.Authorization = authorization
    if (hasBody) {
      output["Content-Type"] = output["Content-Type"] ?? "application/json"
    }
    return output
  }

  const fetchWithAuth = async (path: string, init?: RequestInit): Promise<Response> => {
    const url = buildUrl(path)
    const hasBody = init?.body !== undefined
    const headers = buildHeaders(init?.headers, hasBody)

    // The CodeNomad plugin only talks to the local CodeNomad server.
    // Use a single request implementation that tolerates custom/self-signed certs
    // without disabling TLS verification for the whole Node process.
    return nodeFetch(url, { ...init, headers }, { rejectUnauthorized: false })
  }

  const requestJson = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetchWithAuth(path, init)
    if (!response.ok) {
      const message = await response.text().catch(() => "")
      throw new Error(message || `Request failed with ${response.status}`)
    }

    if (response.status === 204) {
      return undefined as T
    }

    return (await response.json()) as T
  }

  const requestVoid = async (path: string, init?: RequestInit): Promise<void> => {
    const response = await fetchWithAuth(path, init)
    if (!response.ok) {
      const message = await response.text().catch(() => "")
      throw new Error(message || `Request failed with ${response.status}`)
    }
  }

  const requestSseBody = async (path: string): Promise<ReadableStream<Uint8Array>> => {
    const response = await fetchWithAuth(path, { headers: { Accept: "text/event-stream" } })
    if (!response.ok || !response.body) {
      throw new Error(`SSE unavailable (${response.status})`)
    }
    return response.body as ReadableStream<Uint8Array>
  }

  return {
    buildUrl,
    fetch: fetchWithAuth,
    requestJson,
    requestVoid,
    requestSseBody,
  }
}

async function nodeFetch(
  url: string,
  init: RequestInit & { headers?: Record<string, string> },
  tls: { rejectUnauthorized: boolean },
): Promise<Response> {
  const parsed = new URL(url)
  const isHttps = parsed.protocol === "https:"
  const requestFn = isHttps ? https.request : http.request

  const method = (init.method ?? "GET").toUpperCase()
  const headers = init.headers ?? {}
  const body = init.body

  return await new Promise<Response>((resolve, reject) => {
    const req = requestFn(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers,
        ...(isHttps ? { rejectUnauthorized: tls.rejectUnauthorized } : {}),
      },
      (res) => {
        const responseHeaders = new Headers()
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === undefined) continue
          if (Array.isArray(value)) {
            responseHeaders.set(key, value.join(", "))
          } else {
            responseHeaders.set(key, String(value))
          }
        }

        // Convert Node stream -> Web ReadableStream for Response.
        const webBody = Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>
        resolve(new Response(webBody, { status: res.statusCode ?? 0, headers: responseHeaders }))
      },
    )

    const signal = init.signal
    const abort = () => {
      const err = new Error("Request aborted")
      ;(err as any).name = "AbortError"
      req.destroy(err)
      reject(err)
    }

    if (signal) {
      if (signal.aborted) {
        abort()
        return
      }
      signal.addEventListener("abort", abort, { once: true })
      req.once("close", () => signal.removeEventListener("abort", abort))
    }

    req.once("error", reject)

    if (body === undefined || body === null) {
      req.end()
      return
    }

    if (typeof body === "string") {
      req.end(body)
      return
    }

    if (body instanceof Uint8Array) {
      req.end(Buffer.from(body))
      return
    }

    if (body instanceof ArrayBuffer) {
      req.end(Buffer.from(new Uint8Array(body)))
      return
    }

    // Fallback for less common BodyInit types.
    req.end(String(body))
  })
}

function requireEnv(key: string): string {
  const value = process.env[key]
  if (!value || !value.trim()) {
    throw new Error(`[CodeNomadPlugin] Missing required env var ${key}`)
  }
  return value
}

function buildInstanceAuthorizationHeader(): string {
  const username = requireEnv("OPENCODE_SERVER_USERNAME")
  const password = requireEnv("OPENCODE_SERVER_PASSWORD")
  const token = Buffer.from(`${username}:${password}`, "utf8").toString("base64")
  return `Basic ${token}`
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const output: Record<string, string> = {}
  if (!headers) return output

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      output[key] = value
    })
    return output
  }

  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      output[key] = value
    }
    return output
  }

  return { ...headers }
}
