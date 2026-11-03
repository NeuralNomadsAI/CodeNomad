import type { MissionUnavailableReason } from "../../../server/src/missions/model"

/** One task read, from store admission (including its serialized wait) to publication. */
export const TASK_READ_TIMEOUT_MS = 30_000
export type MissionTaskPageFailure = "changed" | "unavailable" | "invalid" | "damaged" | "too-large" | "deadline"
export class MissionTaskPageReadError extends Error {
  constructor(readonly reason: MissionTaskPageFailure, readonly unavailableReason?: MissionUnavailableReason) { super(`Mission task page: ${reason}`) }
}
export function assertTaskReadLive(signal?: AbortSignal, deadline = Infinity): void {
  signal?.throwIfAborted()
  if (performance.now() >= deadline) throw new DOMException("Task read deadline expired", "TimeoutError")
}
/** WebCrypto and queued promises cannot themselves be cancelled. Ignore their late
 * result, and detach our listener when either outcome settles. */
export async function raceTaskRead<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) {
    void promise.catch(() => {}) // work may have started before the caller observed abort
    throw signal.reason
  }
  let abort!: () => void
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
    })])
  } finally { if (abort) signal.removeEventListener("abort", abort) }
}
