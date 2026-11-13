/**
 * Spreads deferred Markdown highlight renders over idle time. A session
 * switch mounts dozens of code-bearing blocks at once; running every block's
 * Shiki highlight inside the mounting task blocks the main thread for seconds
 * on a busy machine. Each drain keeps within the idle deadline, so CPU
 * throttling naturally shrinks the work per task; the `timeout` keeps a
 * permanently busy main thread from starving the queue, and a timeout-fired
 * drain still renders one block, so continuous animation cannot defer
 * highlighting indefinitely.
 *
 * Queued work owns its own validity: callbacks are fenced by their caller
 * (a render request token), so there is no cancellation API.
 */

const queue: Array<() => void> = []
let scheduled = false

/** Wall-clock work budget per idle drain; a deadline alone lets a long run of cheap renders admit one expensive render into the same task. */
const DRAIN_BUDGET_MS = 8

function drain(deadline?: IdleDeadline) {
  scheduled = false
  const startedAt = performance.now()
  let ran = 0
  while (queue.length > 0) {
    if (ran > 0 && (deadline === undefined
      || deadline.timeRemaining() <= 0
      || performance.now() - startedAt >= DRAIN_BUDGET_MS)) break
    queue.shift()!()
    ran += 1
  }
  schedule()
}

function schedule() {
  if (scheduled || queue.length === 0) return
  scheduled = true
  if (typeof requestIdleCallback === "function") requestIdleCallback(drain, { timeout: 200 })
  else setTimeout(() => drain(), 0)
}

/** Runs `render` in idle time, one queued render when no budget remains. */
export function scheduleDeferredHighlight(render: () => void): void {
  queue.push(render)
  schedule()
}
