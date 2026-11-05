import type { Session, SessionStatus } from "../types/session"
import { reconcileSessionInterruptionBoundary } from "./session-interruption-seen"

export type GenerationRecoveryState = "pending" | "interrupted"
export type PersistedGenerationRecovery = "working" | "interrupted"
type NativeOutcome = Session["outcome"]

// Inventory and targeted reads share request order. Weak row provenance retains
// the HTTP snapshot separately from native/local edits applied to that row.
let nextSessionReadId = 0
const readBaselines = new WeakMap<Session, { requestId: number; session: Session }>()
export function nextSessionReadRequestId(): number { return ++nextSessionReadId }
export function inheritSessionReadBaseline(source: Session, target: Session): void {
  const baseline = readBaselines.get(source)
  if (baseline) readBaselines.set(target, baseline)
}
const authorityKeys = ["status", "runtimeStatusKnown", "generationRecovery", "generationAdmissionToken", "generationAdmissionEpoch", "generationAdmissionIdleBoundary"] as const
const runtimeKeys: readonly (keyof Session)[] = [...authorityKeys, "outcome", "retry", "idleSince"]

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
  requestId?: number,
): Session | null {
  const merged = mergeRuntimeState(fetched, captured, latest, deleted, requestId)
  if (merged) reconcileSessionInterruptionBoundary(merged.instanceId, merged)
  return merged
}

function mergeRuntimeState(
  fetched: Session,
  captured: Session | undefined,
  latest: Session | undefined,
  deleted = false,
  requestId?: number,
): Session | null {
  if (deleted) return null
  if (captured && !latest) return null
  const previousRead = latest && readBaselines.get(latest)
  const publish = (session: Session): Session => {
    const baseline = requestId === undefined || (previousRead && previousRead.requestId > requestId)
      ? previousRead : { requestId, session: fetched }
    if (baseline) readBaselines.set(session, baseline)
    return session
  }
  if (!latest) return publish(fetched)
  if (latest === captured) {
    return publish(latest.generationAdmissionToken === undefined ? preservePendingModel(fetched, latest) : { ...fetched, ...latest })
  }
  // An earlier HTTP row supplies a metadata baseline, not a blanket concurrent
  // edit. Runtime authority keeps its original pre-read baseline independently.
  const metadataCaptured = requestId !== undefined && previousRead
    ? previousRead.requestId > requestId ? undefined : previousRead.session
    : captured
  const merged = { ...fetched }
  const keys = new Set<keyof Session>([
    ...(Object.keys(captured ?? {}) as (keyof Session)[]),
    ...(Object.keys(metadataCaptured ?? {}) as (keyof Session)[]),
    ...(Object.keys(latest) as (keyof Session)[]),
  ])
  for (const key of keys) {
    const runtime = runtimeKeys.includes(key)
    const baseline = runtime ? captured : metadataCaptured
    if (baseline && Object.is(baseline[key], latest[key])) continue
    if (!runtime && metadataCaptured && captured && Object.is(captured[key], latest[key])) continue
    if (Object.prototype.hasOwnProperty.call(latest, key)) (merged as any)[key] = latest[key]
    else delete (merged as any)[key]
  }

  // Treat activity and its last outcome as one authority group. A newer idle
  // event can have the same status as the baseline yet clear recovery/token;
  // a stale fetch must not graft an old interruption onto that newer state.
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
  return publish(preservePendingModel(merged, latest))
}

function preservePendingModel(fetched: Session, latest: Session): Session {
  return latest.modelSelectionPending
    ? { ...fetched, model: latest.model, modelSelectionPending: true }
    : fetched
}
