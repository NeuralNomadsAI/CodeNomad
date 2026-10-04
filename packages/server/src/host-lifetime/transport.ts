import { request } from "node:http"
import type { IncomingMessage } from "node:http"
import { HostError, localOrigin, MAX_BYTES, TIMEOUT_MS } from "./protocol"

export async function readBody(request: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BYTES) throw new HostError("request-too-large")
    chunks.push(buffer)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()) } catch { throw new HostError("invalid-json") }
}
export function hostRequest<T>(origin: string, secret: string, scopeKey: string, generation: string, route: string, body: unknown): Promise<T> {
  localOrigin(origin)
  const payload = JSON.stringify(body)
  if (Buffer.byteLength(payload) > MAX_BYTES) return Promise.reject(new HostError("request-too-large"))
  return new Promise((resolve, reject) => {
    const expiresAt = Date.now() + TIMEOUT_MS
    let settled = false
    const req = request(`${origin}${route}`, {
      method: "POST", agent: false,
      headers: { authorization: `Bearer ${secret}`, "x-host-scope": scopeKey, "x-host-generation": generation,
        "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
    }, response => {
      let size = 0
      const chunks: Buffer[] = []
      response.on("data", (chunk: Buffer) => {
        if (settled) return
        size += chunk.length
        if (size > MAX_BYTES) fail(new HostError("response-too-large"))
        else chunks.push(chunk)
      })
      response.on("error", () => fail(new HostError("host-unreachable")))
      response.on("end", () => {
        if (settled) return
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString())
          if (Date.now() >= expiresAt) return fail(new HostError("host-request-timeout"))
          if (response.statusCode !== 200) fail(new HostError(typeof value.code === "string" ? value.code : "host-request-failed"))
          else { settled = true; resolve(value as T) }
        } catch { fail(new HostError("invalid-host-response")) }
      })
    })
    const fail = (error: HostError) => { if (settled) return; settled = true; reject(error); req.destroy() }
    const deadline = setTimeout(() => fail(new HostError("host-request-timeout")), TIMEOUT_MS)
    req.on("close", () => { clearTimeout(deadline); if (!settled) fail(new HostError("host-unreachable")) })
    req.on("error", () => fail(new HostError("host-unreachable")))
    req.end(payload)
  })
}
