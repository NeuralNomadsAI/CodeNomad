/**
 * Spreads deferred mounts over animation frames. A session switch mounts
 * dozens of expanded tool bodies at once; rendering them all inside the
 * mounting task blocks the main thread for seconds on a busy machine. A fixed
 * number of queued mounts joins each frame, so each frame's task stays small
 * whatever the CPU throttle rate, and animation frames keep the queue moving
 * even when the main thread never reports idle.
 *
 * Queued work owns its own validity: callbacks are fenced by their caller
 * (a disposed check), so there is no cancellation API.
 */

const MOUNTS_PER_FRAME = 2

const queue: Array<() => void> = []
let scheduled = false

function flush() {
  scheduled = false
  let mounted = 0
  while (queue.length > 0 && mounted < MOUNTS_PER_FRAME) {
    queue.shift()!()
    mounted += 1
  }
  schedule()
}

function schedule() {
  if (scheduled || queue.length === 0) return
  scheduled = true
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush)
  else setTimeout(flush, 0)
}

/** Runs `mount` in the next frame batch of at most `MOUNTS_PER_FRAME` items. */
export function scheduleFrameBatchedMount(mount: () => void): void {
  queue.push(mount)
  schedule()
}

/**
 * Drains every queued mount at once. A placement-critical navigation (a key
 * jump or an element alignment) must land on its final layout: deferred
 * content still growing over the following frames would leave the held
 * target drifting for the reader.
 */
export function flushFrameBatchedMounts(): void {
  // A pending frame callback finds an empty queue and stops; clearing the
  // flag lets a later mount reschedule at once.
  scheduled = false
  while (queue.length > 0) queue.shift()!()
}
