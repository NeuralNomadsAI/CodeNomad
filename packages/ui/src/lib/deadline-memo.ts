import { createMemo, createSignal, onCleanup } from "solid-js"

/** Recompute on data changes or the next wall-clock deadline, never on a shared tick. */
export function createDeadlineMemo<T>(project: (now: number, wakeAt: (deadline: number) => void) => T) {
  const [revision, advance] = createSignal(0)
  return createMemo(() => {
    revision()
    const now = Date.now()
    let next = Infinity
    const value = project(now, deadline => {
      if (deadline > now && deadline < next) next = deadline
    })
    if (Number.isFinite(next)) {
      const timer = setTimeout(() => advance(n => n + 1), Math.max(0, Math.min(next - Date.now(), 2 ** 31 - 1)))
      onCleanup(() => clearTimeout(timer))
    }
    return value
  })
}
