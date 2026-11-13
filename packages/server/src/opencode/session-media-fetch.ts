import type { ServiceConnection } from "../workspaces/opencode-service"
import { MESSAGE_LIMIT } from "./session-media-contract"

/** Observe one media wait without cancelling a shared acquisition owner. */
export function awaitSessionMedia<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason) }
    pending.then(value => { signal.removeEventListener("abort", abort); resolve(value) }, error => {
      signal.removeEventListener("abort", abort); reject(error)
    })
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
  })
}

/** The original decompressed body is consumed before compatibility can replace it. */
async function consume(response: Response, signal: AbortSignal, assertCurrent: () => void): Promise<Response> {
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0, cancelled = false
  const cancelOnce = (reason: unknown) => {
    if (!reader || cancelled) return
    cancelled = true
    try { void reader.cancel(reason).catch(() => {}) } catch { /* Preserve the primary failure. */ }
  }
  const abort = () => cancelOnce(signal.reason)
  signal.addEventListener("abort", abort, { once: true })
  const current = () => { signal.throwIfAborted(); assertCurrent() }
  try {
    current()
    if (reader) for (;;) {
      current()
      const { done, value } = await awaitSessionMedia(reader.read(), signal)
      current()
      if (done) break
      if (value.byteLength > MESSAGE_LIMIT - size) throw new Error("Media response limit")
      size += value.byteLength
      chunks.push(value)
    }
    current()
    const headers = new Headers(response.headers)
    headers.delete("content-encoding")
    headers.delete("content-length")
    const body = reader ? Buffer.concat(chunks, size) : null
    current()
    return new Response(body, { status: response.status, statusText: response.statusText, headers })
  } catch (error) { cancelOnce(error); throw error }
  finally {
    signal.removeEventListener("abort", abort)
    reader?.releaseLock()
    chunks.length = 0
  }
}

export function createSessionMediaFetch(connection: ServiceConnection, lifetime: AbortSignal, assertCurrent: () => void): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    const signal = AbortSignal.any([request.signal, lifetime])
    const current = () => { signal.throwIfAborted(); assertCurrent(); connection.assertCurrent() }
    current()
    const pending = connection.fetch(request, { signal }, (response, transportSignal) => consume(response, transportSignal, current))
    // A late memory response remains owned even after the header observer leaves.
    void pending.then(response => {
      try { current() } catch { void response.body?.cancel().catch(() => {}) }
    }, () => {})
    const response = await awaitSessionMedia(pending, signal)
    try { current(); return response }
    catch (error) { void response.body?.cancel().catch(() => {}); throw error }
  }
}
