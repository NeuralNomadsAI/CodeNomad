import type { FastifyReply, FastifyRequest } from "fastify"

/** Cancellation belongs to this HTTP observer, never to shared connection work.
 * IncomingMessage.close also fires after a normal request body; only an aborted
 * upload or the downstream response closing before completion revokes admission.
 */
export function requestAdmission(request: FastifyRequest, reply: FastifyReply) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const close = () => { if (!reply.raw.writableFinished) abort() }
  request.raw.once("aborted", abort)
  reply.raw.once("close", close)
  if (request.raw.aborted || reply.raw.destroyed) abort()
  return {
    signal: controller.signal,
    wait: <T>(pending: Promise<T>) => waitForAdmission(pending, controller.signal),
    dispose() {
      request.raw.off("aborted", abort)
      reply.raw.off("close", close)
    },
  }
}

/** Stop one observer without cancelling shared acquisition or awaiting body cleanup. */
export async function waitForAdmission<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // A caller may already have allocated the Promise. Observe its rejection
    // even when admission was revoked immediately before this boundary.
    void pending.catch(() => undefined)
    signal.throwIfAborted()
  }
  let rejectAbort!: () => void
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(signal.reason)
    signal.addEventListener("abort", rejectAbort, { once: true })
  })
  try {
    const result = await Promise.race([pending, aborted])
    signal.throwIfAborted()
    return result
  } finally {
    signal.removeEventListener("abort", rejectAbort)
  }
}
