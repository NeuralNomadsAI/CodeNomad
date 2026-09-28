import { createSignal } from "solid-js"

interface CleanupProgress { controller: AbortController; phase: "planning" | "pruning"; count: number; total: number }
const [jobs, setJobs] = createSignal(new Map<string, CleanupProgress>())
const key = (instanceId: string, sessionId: string) => JSON.stringify([instanceId, sessionId])
export const sessionCleanupProgress = (instanceId: string, sessionId: string) => jobs().get(key(instanceId, sessionId))

export function beginSessionCleanup(instanceId: string, sessionId: string) {
  const id = key(instanceId, sessionId)
  if (jobs().has(id)) return undefined
  const controller = new AbortController()
  const update = (phase: CleanupProgress["phase"], count: number, total = 0) => setJobs(previous => {
    const next = new Map(previous)
    next.set(id, { controller, phase, count, total })
    return next
  })
  update("planning", 0)
  return {
    signal: controller.signal,
    planning: (count: number) => update("planning", count),
    pruning: (count: number, total: number) => update("pruning", count, total),
    finish: () => setJobs(previous => { const next = new Map(previous); next.delete(id); return next }),
  }
}
