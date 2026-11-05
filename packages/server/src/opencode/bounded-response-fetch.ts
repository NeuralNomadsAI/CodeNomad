import { waitForAdmission } from "../server/request-admission"

export class BoundedResponseError extends Error {
  readonly code = "response_limit"
  constructor() { super("Response too large") }
}

/** Buffer decoded HTTP bytes before an SDK parser, on an already captured transport. */
export function boundedResponseFetch(fetch: typeof globalThis.fetch, signal: AbortSignal, current: () => void, limit: number): typeof globalThis.fetch {
  return async (input, init) => {
    const signals = [signal, ...(init?.signal ? [init.signal] : []), ...(input instanceof Request ? [input.signal] : [])]
    const requestSignal = AbortSignal.any(signals)
    const check = () => { requestSignal.throwIfAborted(); current() }
    check()
    let response: Response | undefined
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let cancelled = false
    const cancel = () => {
      if (!response?.body || cancelled) return
      cancelled = true
      void (reader ? reader.cancel() : response.body.cancel()).catch(() => {})
    }
    try {
      const received = await waitForAdmission(fetch(input, { ...init, signal: requestSignal }).then(value => {
        // Ownership starts at receipt, before the admission wait can reject.
        response = value
        if (requestSignal.aborted) cancel()
        return value
      }), requestSignal)
      reader = received.body?.getReader()
      requestSignal.addEventListener("abort", cancel, { once: true })
      check()
      if (!reader) throw new Error("Response has no body")
      const chunks: Uint8Array[] = []
      let size = 0
      while (true) {
        const chunk = await waitForAdmission(reader.read(), requestSignal)
        check()
        if (chunk.done) break
        // Count before retaining even one oversized chunk. Content-Length is advisory.
        if (chunk.value.byteLength > limit - size) throw new BoundedResponseError()
        size += chunk.value.byteLength
        chunks.push(chunk.value)
      }
      check()
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      const headers = new Headers(received.headers)
      // Native/Undici fetch already decoded the body; retain SDK status and content type.
      headers.delete("content-encoding")
      headers.delete("content-length")
      headers.delete("transfer-encoding")
      return new Response(bytes, { status: received.status, statusText: received.statusText, headers })
    } catch (error) {
      // Retire this observer independently of the upstream cancellation cleanup.
      cancel()
      throw error
    } finally {
      requestSignal.removeEventListener("abort", cancel)
      reader?.releaseLock()
    }
  }
}
