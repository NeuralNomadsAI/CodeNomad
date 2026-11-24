/** Optional memory preparation, publication and cleanup share one admission budget. */
export async function withMemoryContextBudget(update: (signal: AbortSignal) => Promise<void>,
  disconnected?: AbortSignal, checkpoint?: () => void): Promise<void> {
  const deadline = new AbortController()
  const signal = disconnected ? AbortSignal.any([disconnected, deadline.signal]) : deadline.signal
  const current = () => { disconnected?.throwIfAborted(); checkpoint?.() }
  current()
  const timer = setTimeout(() => deadline.abort(new Error("Memory context deadline exceeded")), 2_000)
  let onAbort!: () => void
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  try {
    await Promise.race([update(signal), aborted])
  } catch (error) {
    if (!deadline.signal.aborted) throw error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", onAbort)
    // An advisory timeout never overrides a mandatory caller/connection fence.
    current()
  }
}
