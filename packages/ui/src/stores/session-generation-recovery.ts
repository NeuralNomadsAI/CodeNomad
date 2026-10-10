import type { Session, SessionStatus } from "../types/session"

export type GenerationRecoveryState = "pending" | "interrupted"
export type PersistedGenerationRecovery = "working" | "interrupted"
type NativeOutcome = Session["outcome"]

export function resolveHydratedGenerationRecovery(
  _persisted: PersistedGenerationRecovery,
  runtimeStatus: SessionStatus,
  runtimeStatusKnown: boolean,
  outcome?: NativeOutcome,
): GenerationRecoveryState | null {
  if (runtimeStatus === "working" || runtimeStatus === "compacting") return null
  // Older snapshots also persisted locally inferred interruptions. Neither
  // saved marker proves how work ended while this client was absent.
  return resolveAuthoritativeGenerationRecovery("pending", "idle", runtimeStatusKnown ? outcome : undefined)
}

export function resolveAuthoritativeGenerationRecovery(
  current: GenerationRecoveryState | null | undefined,
  status: SessionStatus,
  outcome?: NativeOutcome,
): GenerationRecoveryState | null {
  if (status === "working" || status === "compacting") return null
  if (outcome === "interrupted") return "interrupted"
  if (outcome === "succeeded" || outcome === "failed") return null
  // An idle event/map is activity authority, not execution-outcome authority.
  return current ?? null
}

export function reconcileFetchedSessionRuntime(
  session: Session,
  existing: Session | undefined,
  activeSessions: Record<string, unknown> | null,
): Session {
  const active = activeSessions !== null && Object.prototype.hasOwnProperty.call(activeSessions, session.id)
  const status = activeSessions === null
    ? existing?.status ?? "idle"
    : active && existing?.status === "compacting" ? "compacting" : active ? "working" : "idle"
  const working = status === "working" || status === "compacting"
  // Acknowledged/queued input can still be idle with the previous execution's
  // outcome. Without observed active work, require a newer native idle boundary
  // before attributing that outcome to a local admission.
  const awaitingAdmission = existing?.generationAdmissionEpoch !== undefined
    && existing.generationRecovery === "pending"
    && !working
    && !(typeof session.time.idle === "number" && session.time.idle > (existing.generationAdmissionIdleBoundary ?? existing.time.idle ?? 0))
  const outcome = (activeSessions !== null && working) || awaitingAdmission ? undefined : session.outcome
  return {
    ...session,
    status,
    // SessionInfo.outcome describes the last execution, even during a new run.
    outcome,
    retry: activeSessions === null ? existing?.retry ?? null : null,
    runtimeStatusKnown: activeSessions === null ? existing?.runtimeStatusKnown ?? false : true,
    generationRecovery: activeSessions === null
      ? existing?.generationRecovery ?? null
      : resolveAuthoritativeGenerationRecovery(existing?.generationRecovery, status, outcome),
  }
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
    return latest.generationAdmissionToken === undefined ? preservePendingModel(fetched, latest) : { ...fetched, ...latest }
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

  // Treat activity and its last outcome as one authority group. A newer idle
  // event can have the same status as the baseline yet clear recovery/token;
  // a stale fetch must not graft an old interruption onto that newer state.
  const authorityKeys = ["status", "runtimeStatusKnown", "generationRecovery", "generationAdmissionToken", "generationAdmissionEpoch", "generationAdmissionIdleBoundary"] as const
  const runtimeKeys = [...authorityKeys, "outcome", "retry", "idleSince"] as const
  if (authorityKeys.some(key => !captured || !Object.is(captured[key], latest[key]))) {
    for (const key of runtimeKeys) {
      if (Object.prototype.hasOwnProperty.call(latest, key)) (merged as any)[key] = latest[key]
      else delete (merged as any)[key]
    }
  }

  const fetchedActive = fetched.status === "working" || fetched.status === "compacting"
  if (captured && fetchedActive && latest.generationAdmissionToken === undefined
    && captured.generationAdmissionEpoch === latest.generationAdmissionEpoch
    && latest.runtimeStatusKnown === false && latest.generationRecovery === "pending") {
    for (const key of runtimeKeys) {
      (merged as any)[key] = fetched[key]
    }
  }
  return preservePendingModel(merged, latest)
}

function preservePendingModel(fetched: Session, latest: Session): Session {
  return latest.modelSelectionPending
    ? { ...fetched, model: latest.model, modelSelectionPending: true }
    : fetched
}
