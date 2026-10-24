import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"

const TICK_MS = 1000
const [now, setNow] = createSignal(Date.now())
let subscribers = 0
let timer: ReturnType<typeof setInterval> | undefined

function acquire() {
  if (subscribers++ === 0) {
    setNow(Date.now())
    timer = setInterval(() => setNow(Date.now()), TICK_MS)
  }
}

function release() {
  if (--subscribers === 0 && timer !== undefined) {
    clearInterval(timer)
    timer = undefined
  }
}

/** One shared once-a-second clock for live elapsed times. It runs only while a
 * mounted owner is active (virtualized rows unmount offscreen), never otherwise. */
export function useLiveClock(active: Accessor<boolean>): Accessor<number> {
  createEffect(() => {
    if (!active()) return
    acquire()
    onCleanup(release)
  })
  return now
}
