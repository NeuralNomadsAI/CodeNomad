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
    async wait<T>(pending: Promise<T>): Promise<T> {
      if (controller.signal.aborted) {
        // A caller may already have allocated the Promise. Observe its rejection
        // even when admission was revoked immediately before this boundary.
        void pending.catch(() => undefined)
        controller.signal.throwIfAborted()
      }
      let rejectAbort!: () => void
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = () => reject(controller.signal.reason)
        controller.signal.addEventListener("abort", rejectAbort, { once: true })
      })
      try {
        const result = await Promise.race([pending, aborted])
        controller.signal.throwIfAborted()
        return result
      } finally {
        controller.signal.removeEventListener("abort", rejectAbort)
      }
    },
    dispose() {
      request.raw.off("aborted", abort)
      reply.raw.off("close", close)
    },
  }
}
