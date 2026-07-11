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
  return {
    ...fetched,
    status: latest.status,
    retry: latest.retry,
    idleSince: latest.idleSince,
    runtimeStatusKnown: latest.runtimeStatusKnown,
    generationRecovery: latest.generationRecovery,
    generationAdmissionToken: latest.generationAdmissionToken,
    pendingPermission: latest.pendingPermission,
    pendingQuestion: latest.pendingQuestion,
  }
}
