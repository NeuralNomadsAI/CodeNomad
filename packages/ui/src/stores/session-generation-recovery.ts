import type { Session, SessionStatus } from "../types/session"

export type GenerationRecoveryState = "pending" | "interrupted"
export type PersistedGenerationRecovery = "working" | "interrupted"

export function resolveHydratedGenerationRecovery(
  persisted: PersistedGenerationRecovery,
  runtimeStatus: SessionStatus,
  runtimeStatusKnown: boolean,
): GenerationRecoveryState | null {
  if (runtimeStatus === "working" || runtimeStatus === "compacting") return null
  if (persisted === "interrupted") return "interrupted"
  return runtimeStatusKnown ? "interrupted" : "pending"
}

export function resolveAuthoritativeGenerationRecovery(
  current: GenerationRecoveryState | null | undefined,
  status: SessionStatus,
): GenerationRecoveryState | null {
  if (status === "working" || status === "compacting") return null
  return current === "pending" ? "interrupted" : current ?? null
}

export function getPersistedGenerationRecovery(
  status: SessionStatus,
  recovery: GenerationRecoveryState | null | undefined,
): PersistedGenerationRecovery | null {
  if (status === "working" || status === "compacting" || recovery === "pending") return "working"
  return recovery === "interrupted" ? "interrupted" : null
}

export function mergeFetchedSessionRuntimeState(
  fetched: Session,
  captured: Session | undefined,
  latest: Session | undefined,
  deleted = false,
): Session | null {
  if (deleted) return null
  if (captured && !latest) return null
  if (!latest || (latest === captured && latest.generationAdmissionToken === undefined)) return fetched
  if (captured && latest !== captured) {
    const merged = { ...fetched } as Record<string, unknown>
    const capturedRecord = captured as unknown as Record<string, unknown>
    const latestRecord = latest as unknown as Record<string, unknown>
    for (const key of new Set([...Object.keys(capturedRecord), ...Object.keys(latestRecord)])) {
      if (!Object.is(capturedRecord[key], latestRecord[key])) merged[key] = latestRecord[key]
    }
    if (
      (fetched.status === "working" || fetched.status === "compacting")
      && latest.generationAdmissionToken === undefined
      && latest.runtimeStatusKnown === false
      && latest.generationRecovery === "pending"
    ) {
      merged.status = fetched.status
      merged.runtimeStatusKnown = fetched.runtimeStatusKnown
      merged.generationRecovery = fetched.generationRecovery
      merged.generationAdmissionToken = undefined
      merged.retry = fetched.retry
      merged.idleSince = fetched.idleSince
    }
    return merged as unknown as Session
  }
  return {
    ...fetched,
    ...latest,
  }
}
