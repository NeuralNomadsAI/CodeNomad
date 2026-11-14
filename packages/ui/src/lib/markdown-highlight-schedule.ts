/**
 * Spreads deferred Markdown highlight renders over idle time. A session
 * switch mounts dozens of code-bearing blocks at once; running every block's
 * Shiki highlight inside the mounting task blocks the main thread for seconds
 * on a busy machine. Each drain admits exactly one queued render: the render
 * suspends at its first await and its expensive parse/highlight resumes in
 * microtasks of the drain's own task, so no budget check between items can
 * see that cost. The `timeout` keeps a permanently busy main thread from
 * starving the queue.
 *
 * Queued work owns its own validity: callbacks are fenced by their caller
 * (a render request token), so there is no cancellation API.
 */

const queue: Array<() => void> = []
let scheduled = false

function drain() {
  scheduled = false
  queue.shift()?.()
  schedule()
}

function schedule() {
  if (scheduled || queue.length === 0) return
  scheduled = true
  if (typeof requestIdleCallback === "function") requestIdleCallback(drain, { timeout: 200 })
  else setTimeout(drain, 0)
}

/** Runs `render` as the single admitted render of one idle drain. */
export function scheduleDeferredHighlight(render: () => void): void {
  queue.push(render)
  schedule()
}
