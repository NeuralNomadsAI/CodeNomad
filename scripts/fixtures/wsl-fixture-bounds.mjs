// A predicate's timeout must bound its pending request, not just its next poll.
// Cleanup supplies its own deadline, independent of an aborted fixture run.
export async function boundedFixtureOperation(operation, deadlineAt, label, signal) {
  signal?.throwIfAborted()
  const remaining = deadlineAt - Date.now()
  if (remaining <= 0) throw new Error(`${label} timed out`)
  let timer, onAbort
  try {
    return await Promise.race([
      Promise.resolve().then(() => { signal?.throwIfAborted(); return operation() }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), remaining)
        onAbort = () => reject(signal.reason)
        signal?.addEventListener("abort", onAbort, { once: true })
      }),
    ])
  } finally {
    clearTimeout(timer)
    if (onAbort) signal?.removeEventListener("abort", onAbort)
  }
}
