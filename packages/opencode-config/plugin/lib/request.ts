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
  const baseUrl = config.baseUrl.replace(/\/+$/, "")
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

    return fetch(url, {
      ...init,
      headers,
    })
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
