/**
 * Pure view model for comparing a mission task's requested native execution
 * selection against what its actor session currently reports.
 *
 * Kept out of the component so the comparison stays testable without a DOM, and
 * so the rendering layer only formats what this decides. This never reconfigures,
 * re-routes or falls back: an omitted field and an unobservable field are both
 * reported as such rather than resolved to a guess.
 */

/** Whether the coordinator pinned this field in the task contract, or omitted it. */
export type MissionExecutionRequestState = "pinned" | "native-default"
/** Whether the live native session currently exposes this field at all. */
export type MissionExecutionCurrentState = "known" | "unknown"
/** Only two observed pinned values can be compared; everything else stays unverified. */
export type MissionExecutionMatch = "matches" | "differs" | "unverified"

export interface MissionExecutionField {
  /** Value pinned by the coordinator; undefined when the field was omitted. */
  requested?: string
  /** Value the live native session reports; undefined when not observable. */
  current?: string
  request: MissionExecutionRequestState
  observed: MissionExecutionCurrentState
  match: MissionExecutionMatch
}

export interface MissionExecutionView {
  agent: MissionExecutionField
  model: MissionExecutionField
  variant: MissionExecutionField
  /** True when the contract pins at least one field. */
  pinned: boolean
}

export interface MissionExecutionSelection {
  agent?: string
  model?: { providerID?: string; id?: string; variant?: string }
}

/**
 * Narrow projection of the client session. The client session model carries no
 * variant, so a requested variant can never be confirmed here: it stays unknown
 * rather than being assumed to match.
 */
export interface MissionExecutionSession {
  agent?: string
  model?: { providerId?: string; modelId?: string }
}

export function missionExecutionText(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function missionExecutionPath(prefix: string | undefined, id: string | undefined): string | undefined {
  const parts = [missionExecutionText(prefix), missionExecutionText(id)].filter(Boolean)
  return parts.length ? parts.join("/") : undefined
}

/**
 * Compare one requested value against what the live session reports.
 *
 * An omitted field resolves to the native default, which is whatever the runtime
 * picked rather than a value we can assert, and an unobservable field proves
 * nothing. Both therefore stay unverified rather than being reported as matching.
 */
export function missionExecutionField(requested: string | undefined, current: string | undefined): MissionExecutionField {
  const ask = missionExecutionText(requested)
  const see = missionExecutionText(current)
  const request: MissionExecutionRequestState = ask ? "pinned" : "native-default"
  const observed: MissionExecutionCurrentState = see ? "known" : "unknown"
  const match: MissionExecutionMatch = !ask || !see ? "unverified" : ask === see ? "matches" : "differs"
  return { requested: ask, current: see, request, observed, match }
}

export function describeMissionExecution(
  task: { execution?: MissionExecutionSelection; actorSessionId?: string; executionMode?: { kind: "native" | "independent" }; nativeBinding?: unknown },
  session: MissionExecutionSession | undefined,
): MissionExecutionView {
  const requested = task.execution
  // Mutable session settings do not establish the profile of a native invocation.
  // Keep every observed field unknown until an authoritative invocation projection exists.
  const observedSession = task.executionMode?.kind === "native" || task.nativeBinding ? undefined : session
  const agent = missionExecutionField(requested?.agent, observedSession?.agent)
  const model = missionExecutionField(
    missionExecutionPath(requested?.model?.providerID, requested?.model?.id),
    missionExecutionPath(observedSession?.model?.providerId, observedSession?.model?.modelId),
  )
  const variant = missionExecutionField(requested?.model?.variant, undefined)
  return {
    agent,
    model,
    variant,
    pinned: agent.request === "pinned" || model.request === "pinned" || variant.request === "pinned",
  }
}
