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

export function createCodeNomadClient(config: CodeNomadConfig) {
  return {
    postEvent: (event: PluginEvent) => postPluginEvent(config.baseUrl, config.instanceId, event),
    startEvents: (onEvent: (event: PluginEvent) => void) => startPluginEvents(config.baseUrl, config.instanceId, onEvent),
  }
}

function requireEnv(key: string): string {
  const value = process.env[key]
  if (!value || !value.trim()) {
    throw new Error(`[CodeNomadPlugin] Missing required env var ${key}`)
  }
  return value
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function postPluginEvent(baseUrl: string, instanceId: string, event: PluginEvent) {
  const url = `${baseUrl.replace(/\/+$/, "")}/workspaces/${instanceId}/plugin/event`
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(event),
  })

  if (!response.ok) {
    throw new Error(`[CodeNomadPlugin] POST ${url} failed (${response.status})`)
  }
}

async function startPluginEvents(baseUrl: string, instanceId: string, onEvent: (event: PluginEvent) => void) {
  const url = `${baseUrl.replace(/\/+$/, "")}/workspaces/${instanceId}/plugin/events`

  // Fail plugin startup if we cannot establish the initial connection.
  const initialBody = await connectWithRetries(url, 3)

  // After startup, keep reconnecting; throw after 3 consecutive failures.
  void consumeWithReconnect(url, onEvent, initialBody)
}

async function connectWithRetries(url: string, maxAttempts: number) {
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { Accept: "text/event-stream" } })
      if (!response.ok || !response.body) {
        throw new Error(`[CodeNomadPlugin] SSE unavailable (${response.status})`)
      }
      return response.body
    } catch (error) {
      lastError = error
      await delay(500 * attempt)
    }
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`[CodeNomadPlugin] Failed to connect to CodeNomad after ${maxAttempts} retries: ${reason}`)
}

async function consumeWithReconnect(
  url: string,
  onEvent: (event: PluginEvent) => void,
  initialBody: ReadableStream<Uint8Array>,
) {
  let consecutiveFailures = 0
  let body: ReadableStream<Uint8Array> | null = initialBody

  while (true) {
    try {
      if (!body) {
        body = await connectWithRetries(url, 3)
      }

      await consumeSseBody(body, onEvent)
      body = null
      consecutiveFailures = 0
    } catch (error) {
      body = null
      consecutiveFailures += 1
      if (consecutiveFailures >= 3) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`[CodeNomadPlugin] Plugin event stream failed after 3 retries: ${reason}`)
      }
      await delay(500 * consecutiveFailures)
    }
  }
}

async function consumeSseBody(body: ReadableStream<Uint8Array>, onEvent: (event: PluginEvent) => void) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done || !value) {
      break
    }

    buffer += decoder.decode(value, { stream: true })

    let separatorIndex = buffer.indexOf("\n\n")
    while (separatorIndex >= 0) {
      const chunk = buffer.slice(0, separatorIndex)
      buffer = buffer.slice(separatorIndex + 2)
      separatorIndex = buffer.indexOf("\n\n")

      const event = parseSseChunk(chunk)
      if (event) {
        onEvent(event)
      }
    }
  }

  throw new Error("SSE stream ended")
}

function parseSseChunk(chunk: string): PluginEvent | null {
  const lines = chunk.split(/\r?\n/)
  const dataLines: string[] = []

  for (const line of lines) {
    if (line.startsWith(":")) continue
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart())
    }
  }

  if (dataLines.length === 0) return null

  const payload = dataLines.join("\n").trim()
  if (!payload) return null

  try {
    const parsed = JSON.parse(payload)
    if (!parsed || typeof parsed !== "object" || typeof (parsed as any).type !== "string") {
      return null
    }
    return parsed as PluginEvent
  } catch {
    return null
  }
}
