import { ProviderHttpError } from "./shared"
import { isIP } from "node:net"

const MAX_RESPONSE_BYTES = 65_536

/** Credential destinations: HTTPS FQDN, no userinfo, explicit port, query or fragment. */
export function parseQuotaBaseURL(value: unknown): URL | null {
  if (typeof value !== "string" || value.length > 2048 || /[\s\u0000-\u001f\u007f\\]/.test(value)) return null
  const match = /^https:\/\/([a-z0-9.-]+)(\/[^?#]*)?$/i.exec(value)
  if (!match) return null
  try {
    const url = new URL(value)
    const host = url.hostname
    if (isIP(host) || host.length > 253 || !host.includes(".") || host.endsWith(".localhost")) return null
    if (!host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return null
    return url
  } catch { return null }
}

export class BoundedResponseError extends Error {
  constructor(message = "Invalid quota response") { super(message) }
}

// Credential-bearing quota reads. Errors are generic on purpose: callers must
// never log or return upstream bodies, headers or transport details.
export async function fetchBoundedJson(url: string, headers: Record<string, string>, signal = AbortSignal.timeout(15_000),
  maxBytes = MAX_RESPONSE_BYTES, request: Pick<RequestInit, "method" | "body"> & { errorCodes?: readonly string[] } = {}): Promise<unknown> {
  signal.throwIfAborted()
  const { errorCodes, ...init } = request
  const response = await fetch(url, { ...init, signal, redirect: "error", headers })
  if (!response.ok && (!errorCodes || !response.body)) {
    await response.body?.cancel().catch(() => {})
    throw new ProviderHttpError(response.status)
  }
  if (!response.body) throw new BoundedResponseError()
  const reader = response.body.getReader()
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener("abort", abort, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > Math.min(maxBytes, MAX_RESPONSE_BYTES)) throw new BoundedResponseError("Quota response too large")
      chunks.push(chunk.value)
    }
    signal.throwIfAborted()
    let payload
    try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) }
    catch { throw new BoundedResponseError() }
    if (!response.ok) {
      const code = payload?.code ?? payload?.error?.code
      throw new ProviderHttpError(response.status, errorCodes?.includes(code) ? code : undefined)
    }
    return payload
  } catch (error) {
    // Malformed/oversized error bodies still retain their HTTP status, never their contents.
    if (!response.ok && !(error instanceof ProviderHttpError)) throw new ProviderHttpError(response.status)
    throw error
  } finally {
    signal.removeEventListener("abort", abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
