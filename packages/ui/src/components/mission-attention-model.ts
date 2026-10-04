/**
 * Pure reconciliation for the mission "needs your decision" section.
 *
 * Kept out of the component so the native Form/permission correlation stays
 * testable without a DOM, and so the rendering layer only formats what this
 * decides. Nothing here writes mission state: a live wait comes from a still-open
 * native request, never from a derived task status.
 */

import type { MissionActivityProjection } from "../../../server/src/api-types"

export type MissionObservedFamily = NonNullable<MissionActivityProjection["missions"][number]["family"]>

/** Display correlation only. No local catalogue/tree inference or actor admission. */
export function selectMissionFamilyMembers(actors: readonly MissionAttentionActor[], family?: MissionObservedFamily): MissionObservedFamily["members"] {
  // The server bounds eight declared roots to 32 descendants apiece.
  if (family?.state !== "observed" || family.members.length > 8 * 33) return []
  const declared = new Set(actors.map(actor => actor.sessionId))
  const members = new Map(family.members.map(member => [member.sessionId, member]))
  if (members.size !== family.members.length) return []
  return family.members.filter(member => {
    if (!member.sessionId || member.sessionId === "global" || member.kind !== "ordinary" || declared.has(member.sessionId)) return false
    const seen = new Set([member.sessionId])
    let parent = member.parentSessionId
    while (parent && !seen.has(parent)) {
      if (declared.has(parent)) return parent === member.actorSessionId
      seen.add(parent)
      parent = members.get(parent)?.parentSessionId
    }
    return false
  })
}

export function missionIncludesSession(actors: readonly MissionAttentionActor[], sessionId: string, family?: MissionObservedFamily): boolean {
  return sessionId !== "global" && (actors.some(actor => actor.sessionId === sessionId)
    || selectMissionFamilyMembers(actors, family).some(member => member.sessionId === sessionId))
}

export type MissionAttentionKind = "form" | "permission" | "blocked"

export interface MissionAttentionItem {
  id: string
  kind: MissionAttentionKind
  /** Native session that must be opened to answer; absent for a reported blockage. */
  sessionId?: string
  /** Nearest observed declared actor; never replaces the native answer target. */
  actorSessionId?: string
  /** Task the blockage was reported against; absent for still-open native requests. */
  taskKey?: string
  title: string
  /** Questions asked by an open form. */
  questions?: number
  /** Resources guarded by an open permission request. */
  resources?: readonly string[]
  /** Report summary of a blockage the actor already returned. */
  summary?: string
  /** True while the native request is still open. A reported blockage is history. */
  open: boolean
}

/** Narrow native projections, so this stays testable without the client brands. */
export interface MissionAttentionForm {
  id: string
  sessionID: string
  title: string
  fields: readonly unknown[]
}

export interface MissionAttentionPermission {
  id: string
  sessionID: string
  action?: string
  resources?: readonly string[]
}

export interface MissionAttentionActor {
  sessionId: string
}

export interface MissionAttentionTask {
  id: string
  key: string
  title: string
  report?: { outcome: string; summary: string }
}

export interface MissionAttentionSource {
  actors: readonly MissionAttentionActor[]
  forms: readonly MissionAttentionForm[]
  permissions: readonly MissionAttentionPermission[]
  tasks: readonly MissionAttentionTask[]
  family?: MissionObservedFamily
}

/**
 * Native requests carry no session identity, so they cannot be attributed to a
 * mission actor and are never shown as if one were waiting on an answer.
 */
export const MISSION_ATTENTION_UNCORRELATABLE_SESSION = "global"

/**
 * Reconcile still-open native requests against this mission's actors, then list
 * reported blockages separately.
 *
 * The live "waiting on you" state comes only from a native request that is still
 * queued. It is deliberately not derived from the historical `needs-input` task
 * status, which the map produces from a terminal `blocked` report and therefore
 * means "this actor already returned", not "the mission holds an answer".
 */
export function selectMissionAttention(source: MissionAttentionSource): MissionAttentionItem[] {
  const actorSessions = new Map(source.actors.map(actor => [actor.sessionId, actor.sessionId]))
  for (const member of selectMissionFamilyMembers(source.actors, source.family)) actorSessions.set(member.sessionId, member.actorSessionId)
  const corlatable = (sessionID: string | undefined): sessionID is string =>
    sessionID !== undefined && sessionID !== "" && sessionID !== MISSION_ATTENTION_UNCORRELATABLE_SESSION
    && actorSessions.has(sessionID)

  const open: MissionAttentionItem[] = [
    ...source.forms.filter(form => corlatable(form.sessionID)).map(form => ({
      id: `form:${form.id}`,
      kind: "form" as const,
      sessionId: form.sessionID,
      actorSessionId: actorSessions.get(form.sessionID),
      title: form.title,
      questions: form.fields.length,
      open: true,
    })),
    ...source.permissions.filter(permission => corlatable(permission.sessionID)).map(permission => ({
      id: `permission:${permission.id}`,
      kind: "permission" as const,
      sessionId: permission.sessionID,
      actorSessionId: actorSessions.get(permission.sessionID),
      title: permission.action?.trim() || permission.id,
      resources: permission.resources?.filter(Boolean),
      open: true,
    })),
  ]

  const blocked: MissionAttentionItem[] = source.tasks
    .filter(task => task.report?.outcome === "blocked")
    .map(task => ({
      id: `blocked:${task.id}`,
      kind: "blocked" as const,
      taskKey: task.key,
      title: task.title,
      summary: task.report?.summary,
      open: false,
    }))

  return [...open, ...blocked]
}
