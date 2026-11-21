export { setTimeout as sleep } from "node:timers/promises"

export const now = () => performance.timeOrigin + performance.now()
export const MARKER = /MK[A-Z]{2}\d{6}K/g

export async function json(url, { method = "GET", headers, body } = {}) {
  const response = await fetch(url, {
    method, headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) throw Error(`${method} ${url} returned ${response.status}: ${(await response.text()).slice(0, 400)}`)
  const text = await response.text()
  return text ? JSON.parse(text) : undefined
}

export async function sseReader(url, authorization, onFrame) {
  const controller = new AbortController()
  const response = await fetch(url, { headers: { authorization }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(360_000)]) })
  if (!response.ok || !response.headers.get("content-type")?.startsWith("text/event-stream")) throw Error(`Expected SSE from ${url}`)
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
    await reading
    if (failure) throw failure
  }
}

export function p95(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  return sorted[Math.ceil(sorted.length * .95) - 1]
}
