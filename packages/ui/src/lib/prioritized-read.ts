import { createComputed, createRoot } from "solid-js"
import { backgroundReads } from "./background-read-queue"

// A pending session read must follow user selection even while both secondary
// slots are occupied. Promotion removes the queued admission; it never restarts
// an already dispatched read or cancels its upstream request.
export async function prioritizedRead<T>(
  isForeground: () => boolean,
  signal: AbortSignal,
  read: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted()
  if (isForeground()) return read()

  const queued = new AbortController()
  const promoted = Symbol("foreground read")
  const abort = () => queued.abort(signal.reason)
  signal.addEventListener("abort", abort, { once: true })
  let started = false
  const dispose = createRoot(dispose => {
    createComputed(() => {
      if (isForeground() && !started) queued.abort(promoted)
    })
    return dispose
  })
  try {
    return await backgroundReads.run(queued.signal, () => {
      started = true
      dispose()
      return read()
    })
  } catch (error) {
    if (error !== promoted) throw error
    signal.throwIfAborted()
    return read()
  } finally {
    dispose()
    signal.removeEventListener("abort", abort)
  }
}
