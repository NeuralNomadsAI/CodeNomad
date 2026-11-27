import { setTimeout as sleep } from "node:timers/promises"
export { sleep }

export const now = () => performance.timeOrigin + performance.now()
export const MARKER = /MK[A-Z]{2}\d{6}K/g

export async function json(send, route, { method = "GET", headers, body } = {}) {
  const response = await send(route, {
    method, headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) {
    await response.body?.cancel?.().catch(() => {})
    throw Error(`${method} ${route} returned ${response.status}`)
  }
  const text = await response.text()
  return text ? JSON.parse(text) : undefined
}

export async function sseReader(send, onFrame, openTimeoutMs = 15_000) {
  const controller = new AbortController()
  const openTimer = setTimeout(() => controller.abort(Error("SSE open timed out")), openTimeoutMs)
  let response
  try {
    response = await send("/api/event", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(360_000)]) })
  } finally {
    clearTimeout(openTimer)
  }
  if (!response.ok || !response.headers.get("content-type")?.startsWith("text/event-stream")) {
    controller.abort()
    void response.body?.cancel?.().catch(() => {})
    throw Error("Expected SSE from the attested daemon")
  }
  let failure
  const reading = (async () => {
    const decoder = new TextDecoder()
    let buffer = ""
    for await (const chunk of response.body) {
      const at = now()
      buffer += decoder.decode(chunk, { stream: true }).replaceAll("\r", "")
      let i
      while ((i = buffer.indexOf("\n\n")) >= 0) {
        const data = buffer.slice(0, i).split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n")
        buffer = buffer.slice(i + 2)
        if (data) onFrame(data, at)
      }
    }
    if (!controller.signal.aborted) throw Error("Daemon event stream ended during measurement")
  })().catch(error => { if (!controller.signal.aborted) failure = error })
  return async () => {
    controller.abort()
    void response.body?.cancel?.().catch(() => {})
    await Promise.race([reading, sleep(2000, undefined, { ref: false })])
    if (failure) throw failure
  }
}

export function p95(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  return sorted[Math.ceil(sorted.length * .95) - 1]
}
