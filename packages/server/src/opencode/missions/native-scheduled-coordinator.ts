import type { Plugin } from "@opencode/plugin/effect"
import { isSessionNotFoundError } from "@opencode/client"
import { Effect, Schema } from "effect"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Session } from "@opencode/schema/session"
import { canonicalAuthority } from "../../missions/authority-protocol"
import { matchesExecution } from "../../missions/execution"
import type { MissionDocument } from "../../missions/mission-document"
import type { MissionNativeRunner, MissionNativeService } from "./native-service-adapter"
import type { NativeMissionSession } from "../../missions/control-types"
import { abortableNativeEffect } from "./native-invocation"
import { isReservedMissionScheduleSessionID } from "../../missions/mission-schedule-carrier-identity"
import { NATIVE_SCHEDULE_CARRIER_MARKER, nativeScheduleDocumentKey } from "./native-schedule-carrier-binding"
import { scheduledPassageOwner } from "./native-scheduled-passage-owner"
import { assertAgentScheduledCoordinatorSelection } from "./native-scheduled-coordinator-adoption"

/** Explicit coordinator adoption keeps the conversation and all unrelated metadata.
 * State-setting calls reconcile by readback; only admission sends the original input. */
export async function adoptNativeScheduledCoordinator(ctx: Plugin.Context, run: MissionNativeRunner,
  native: MissionNativeService, doc: MissionDocument, metadata: Record<string, unknown>, current: () => true,
  qualify: () => Promise<void>, signal: AbortSignal, observeCurrent: () => true = current,
  pin?: (session: NativeMissionSession) => (() => true),
  validate?: () => Promise<() => true>) {
  const pending = doc.pending!, selected = pending.configuration.profiles?.coordinator
  if (!pending.coordinatorReused || !selected?.agent || !selected.model) throw new Error("Existing coordinator selection unavailable")
  // The full ownership validation runs when the calendar is saved, never per passage.
  assertAgentScheduledCoordinatorSelection(pending.configuration, doc.creation?.author)
  const agentValidation = doc.creation?.author ? validate : undefined
  await agentValidation?.()
  const read = async () => {
    observeCurrent()
    signal.throwIfAborted()
    const value = await native.get({ sessionID: pending.coordinatorSessionID }, { signal })
    observeCurrent()
    if (value.id !== pending.configuration.coordinatorSessionID || value.parentID || value.projectID !== doc.projectID
      || value.location.directory !== native.location.directory || value.location.workspaceID !== native.location.workspaceID
      || isReservedMissionScheduleSessionID(value.id) || value.metadata?.[NATIVE_SCHEDULE_CARRIER_MARKER] !== undefined)
      throw new Error("Existing coordinator identity differs")
    return value
  }
  const apply = async (operation: (value: Awaited<ReturnType<typeof read>>) => Effect.Effect<unknown, unknown, never>, accepted: () => Promise<boolean>) => {
    const fresh = await read(), prepared = operation(fresh)
    if (!Effect.isEffect(prepared)) throw new Error("Existing coordinator mutation unavailable")
    const placement = pin?.(fresh)
    const agentCurrent = await agentValidation?.()
    await qualify()
    try { await run(abortableNativeEffect(Effect.suspend(() => { current(); placement?.(); agentCurrent?.(); return prepared }), signal)) }
    catch (error) { if (!await accepted()) throw error }
    observeCurrent()
    if (!await accepted()) throw new Error("Existing coordinator update unconfirmed")
  }
  let value = await read()
  await assertCoordinatorFree(ctx, run, doc, value)
  if (value.agent !== selected.agent) await apply(fresh => ctx.session.switchAgent({ sessionID: Session.ID.make(fresh.id), agent: Agent.ID.make(selected.agent!) }),
    async () => (await read()).agent === selected.agent)
  value = await read()
  if (!matchesExecution(selected, value)) await apply(fresh => ctx.session.switchModel({ sessionID: Session.ID.make(fresh.id), model: Schema.decodeUnknownSync(Model.Ref)(selected.model!) }),
    async () => matchesExecution(selected, await read()))
  value = await read()
  const expected = metadata["codenomad.mission"]
  const marked = async () => canonicalAuthority((await read()).metadata?.["codenomad.mission"] ?? null) === canonicalAuthority(expected)
  if (!await marked()) await apply(fresh => ctx.session.update({ sessionID: Session.ID.make(fresh.id),
    metadata: JSON.parse(canonicalAuthority({ ...fresh.metadata, "codenomad.mission": expected })) }), marked)
}

/** A conversation holds one passage marker: tool calls and subagents follow it. While another
 * calendar's passage runs in it, this start fails before marking; the passage stays pending
 * and the next reconciliation starts it once the conversation is free. A stale marker is replaced. */
async function assertCoordinatorFree(ctx: Plugin.Context, run: MissionNativeRunner, doc: MissionDocument, session: NativeMissionSession) {
  const raw = session.metadata?.["codenomad.mission"]
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return
  const marker = raw as { missionID?: string; document?: { missionID?: string; passageID?: string; coordinatorReused?: unknown } }
  if (typeof marker.document?.missionID !== "string" || marker.document.missionID === doc.id) return
  let running = false
  try {
    const owner = await run(ctx.storage.get(nativeScheduleDocumentKey(ctx, marker.document.missionID)))
    running = !!scheduledPassageOwner(owner, doc, session.id, marker)
  } catch { /* Unreadable or stale: replaced. */ }
  if (running) throw new Error("Coordinator runs another passage")
}

function isMissingSession(error: unknown): boolean {
  if (isSessionNotFoundError(error)) return true
  const tag = error && typeof error === "object" && "_tag" in error ? (error as { _tag?: unknown })._tag : undefined
  return tag === "Session.NotFoundError"
}

/** Called only after the archive CAS. Clearing the exact old marker releases
 * ordinary conversation use independently of the history retention window. */
export async function releaseNativeScheduledCoordinator(ctx: Plugin.Context, run: MissionNativeRunner, native: MissionNativeService,
  pending: Pick<NonNullable<MissionDocument["pending"]>, "coordinatorReused" | "coordinatorSessionID" | "missionID" | "id">,
  documentID: string, current: () => true, signal: AbortSignal,
  pin: (session: NativeMissionSession) => (() => true), absent?: (id: string) => (() => true)): Promise<(() => true) | undefined> {
  if (!pending.coordinatorReused) return current
  current()
  const read = async () => {
    try { const session = await native.get({ sessionID: pending.coordinatorSessionID }, { signal }); current(); return session }
    catch (error) { current(); if (isMissingSession(error) && absent) return undefined; throw error }
  }
  const matches = (session: NativeMissionSession) => {
    const marker = session.metadata?.["codenomad.mission"] as { missionID?: unknown; document?: unknown } | undefined
    return marker?.missionID === pending.missionID && canonicalAuthority(marker.document ?? null)
      === canonicalAuthority({ missionID: documentID, passageID: pending.id, coordinatorReused: true })
  }
  const session = await read()
  if (!session) return absent!(pending.coordinatorSessionID)
  if (!matches(session)) return pin(session)
  if (session.parentID || session.projectID !== native.location.project.id || session.location.directory !== native.location.directory
    || session.location.workspaceID !== native.location.workspaceID) return undefined
  const { "codenomad.mission": _marker, ...metadata } = session.metadata!
  const effect = ctx.session.update({ sessionID: Session.ID.make(session.id), metadata: JSON.parse(canonicalAuthority(metadata)) })
  const placement = pin(session)
  try { await run(abortableNativeEffect(Effect.suspend(() => { current(); placement(); return effect }), signal)) }
  catch { signal.throwIfAborted(); current() }
  const confirmed = await read()
  if (!confirmed) return absent!(pending.coordinatorSessionID)
  return matches(confirmed) ? undefined : pin(confirmed)
}
