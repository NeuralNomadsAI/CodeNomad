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
  if (!latest) return fetched
  if (latest === captured) {
    return latest.generationAdmissionToken === undefined ? fetched : { ...fetched, ...latest }
  }
  const merged = { ...fetched }
  const keys = new Set<keyof Session>([
    ...(Object.keys(captured ?? {}) as (keyof Session)[]),
    ...(Object.keys(latest) as (keyof Session)[]),
  ])
  for (const key of keys) {
    if (captured && Object.is(captured[key], latest[key])) continue
    if (Object.prototype.hasOwnProperty.call(latest, key)) (merged as any)[key] = latest[key]
    else delete (merged as any)[key]
  }

  const fetchedActive = fetched.status === "working" || fetched.status === "compacting"
  if (captured && fetchedActive && latest.generationAdmissionToken === undefined
    && latest.runtimeStatusKnown === false && latest.generationRecovery === "pending") {
    for (const key of ["status", "runtimeStatusKnown", "generationRecovery", "generationAdmissionToken", "retry", "idleSince"] as const) {
      (merged as any)[key] = fetched[key]
    }
  }
  return merged
}
