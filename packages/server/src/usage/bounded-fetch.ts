import { ProviderHttpError } from "./shared"

const MAX_RESPONSE_BYTES = 65_536

// Credential-bearing quota reads. Errors are generic on purpose: callers must
// never log or return upstream bodies, headers or transport details.
export async function fetchBoundedJson(url: string, headers: Record<string, string>, signal: AbortSignal,
  maxBytes = MAX_RESPONSE_BYTES): Promise<unknown> {
  const response = await fetch(url, { signal, redirect: "error", headers })
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {})
    throw new ProviderHttpError(response.status)
  }
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
      if (size > maxBytes) throw new Error("Quota response too large")
      chunks.push(chunk.value)
    }
    signal.throwIfAborted()
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } finally {
    signal.removeEventListener("abort", abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
