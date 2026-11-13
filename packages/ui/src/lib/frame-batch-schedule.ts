/**
 * Spreads deferred mounts over animation frames. A session switch mounts
 * dozens of expanded tool bodies at once; rendering them all inside the
 * mounting task blocks the main thread for seconds on a busy machine. A fixed
 * number of queued mounts joins each frame, so each frame's task stays small
 * whatever the CPU throttle rate, and animation frames keep the queue moving
 * even when the main thread never reports idle.
 *
 * Queued work owns its own validity: callbacks are fenced by their caller
 * (a disposed check), so there is no per-mount cancellation API.
 */

const MOUNTS_PER_FRAME = 2

const queue: Array<() => void> = []
let armed: number | null = null

function flush() {
  armed = null
  let mounted = 0
  while (queue.length > 0 && mounted < MOUNTS_PER_FRAME) {
    queue.shift()!()
    mounted += 1
  }
  schedule()
}

function schedule() {
  if (armed !== null || queue.length === 0) return
  if (typeof requestAnimationFrame === "function") armed = requestAnimationFrame(flush)
  else armed = setTimeout(flush, 0) as unknown as number
}

function disarm() {
  if (armed === null) return
  if (typeof requestAnimationFrame === "function") cancelAnimationFrame(armed)
  else clearTimeout(armed as unknown as ReturnType<typeof setTimeout>)
  armed = null
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
  disarm()
  while (queue.length > 0) queue.shift()!()
}
