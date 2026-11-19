import type { RestorableWorkspaceTabState } from "./client-state-codec"
import { getUnavailableRestoredSessionIds, resolveRestoredSessionSelection } from "./app-session-reconciliation"
import { getAbortReason } from "./app-session-restore-timeout"
import { getRestoredSessionIds } from "./app-session-restored-session-ids"
import { currentDraftAbsences, hydrateWorkspacePromptState, recoverDeletedWorkspacePrompts } from "./app-session-prompt-hydration"
import { MESSAGE_STREAM_SCROLL_SCOPE, messageStoreBus, type MessageScrollSnapshotSeed } from "./message-v2/bus"
import { getSessionAncestorIdsFromMap } from "./session-tree"
import { getAuthoritativelyDeletedSessionIdsForInstance, seedRestoredSessionSelection } from "./session-state"
import { seedSessionOutlineIndexes } from "./session-outline"
import { seedSessionCatalog } from "./session-catalog-hydration"
import { hydrateSeenInterruptions } from "./session-interruption-seen"
import { backendEvents } from "../lib/server-events"
import { seedTabViewState } from "./tab-view-state"
import { isLocalDraftId, NO_SESSION_DRAFT_SESSION_ID } from "./local-draft-ids"
import { removeSessionRuntimeState } from "./session-api"
import { omitSupersededClosedDrafts } from "./closed-workspace-drafts"
import {
  getSessions, hasAuthoritativeSessionSelection, hydrateActiveSessionSelection,
  hydrateRestoredSessionChain, hydrateSessionExpansion, hydrateSessionGenerationRecovery, hydrateSessionIdleMarkers,
} from "./sessions"

export { NO_SESSION_DRAFT_SESSION_ID } from "./local-draft-ids"

export function seedRestoredWorkspaceState(
  instanceId: string,
  snapshot: RestorableWorkspaceTabState,
): void {
  seedTabViewState(instanceId, snapshot.viewState)
  const scrollSeeds: MessageScrollSnapshotSeed[] = Object.entries(snapshot.scrollSnapshots)
    .map(([sessionId, scrollSnapshot]) => ({ sessionId, scope: MESSAGE_STREAM_SCROLL_SCOPE, snapshot: scrollSnapshot }))
  messageStoreBus.seedScrollSnapshots(instanceId, scrollSeeds)
  seedSessionOutlineIndexes(instanceId, snapshot.outlineIndexes)
  seedSessionCatalog(instanceId, snapshot.sessionCatalog)
  hydrateSessionIdleMarkers(instanceId, snapshot.unseenIdleSince)
  hydrateSessionGenerationRecovery(instanceId, snapshot.generationRecovery)
  hydrateSeenInterruptions(instanceId, snapshot.seenInterruptions)
  if (snapshot.expandedSessionIds !== undefined) hydrateSessionExpansion(instanceId, snapshot.expandedSessionIds)
  seedRestoredWorkspacePrompts(instanceId, snapshot)
  seedRestoredSessionSelection(instanceId, snapshot.activeParentSessionId ?? null, snapshot.activeSessionId ?? snapshot.activeParentSessionId ?? null)
}

function seedRestoredWorkspacePrompts(instanceId: string, snapshot: RestorableWorkspaceTabState) {
  const prompts = omitSupersededClosedDrafts(instanceId, snapshot)
  hydrateWorkspacePromptState(instanceId, prompts, new Set(getSessions(instanceId).map(session => session.id)), NO_SESSION_DRAFT_SESSION_ID)
  recoverDeletedWorkspacePrompts(instanceId, prompts)
}

export async function hydrateRestoredWorkspaceState(
  instanceId: string,
  snapshot: RestorableWorkspaceTabState,
  signal: AbortSignal,
  isCurrentBinding: () => boolean,
): Promise<Set<string> | null> {
  const attachment = backendEvents.signalForInstance(instanceId)
  attachment.throwIfAborted()
  if (signal.aborted) throw getAbortReason(signal)
  const owns = isCurrentBinding
  isCurrentBinding = () => !attachment.aborted && owns()
  if (!isCurrentBinding()) return null
  // Session selection mounts MessageSection synchronously. Seed scroll state
  // first so its initial restore cannot mistake an unavailable snapshot for a
  // deliberate at-bottom state.
  seedRestoredWorkspaceState(instanceId, snapshot)
  await hydrateRestoredSessionChain(instanceId, [snapshot.activeParentSessionId, snapshot.activeSessionId], signal, isCurrentBinding, { reconcileDeparture: true })
  attachment.throwIfAborted()
  if (signal.aborted) throw getAbortReason(signal)
  if (!isCurrentBinding()) return null
  let sessions = getSessions(instanceId)
  let selection = resolveRestoredSessionSelection(sessions, snapshot.activeParentSessionId, snapshot.activeSessionId)
  const hydrateSelection = () => hydrateActiveSessionSelection(instanceId, snapshot.activeParentSessionId ?? null,
    snapshot.activeSessionId ?? snapshot.activeParentSessionId ?? null, () => !signal.aborted && isCurrentBinding())
  if (!hasAuthoritativeSessionSelection(instanceId)) {
    hydrateSelection()
  }
  hydrateWorkspacePromptState(
    instanceId,
    omitSupersededClosedDrafts(instanceId, snapshot),
    new Set(sessions.map(({ id }) => id)),
    NO_SESSION_DRAFT_SESSION_ID,
  )

  const requestedPrompts = omitSupersededClosedDrafts(instanceId, snapshot)
  const absenceProofs = await hydrateRestoredSessionChain(instanceId, getRestoredSessionIds([
    Object.keys(requestedPrompts.drafts),
    Object.keys(requestedPrompts.attachments),
  ]), signal, isCurrentBinding, { verifyDrafts: true, reconcileDeparture: true })
  attachment.throwIfAborted()
  if (signal.aborted) throw getAbortReason(signal)
  if (!isCurrentBinding()) return null
  const prompts = omitSupersededClosedDrafts(instanceId, snapshot)
  const absent = currentDraftAbsences(absenceProofs)
  for (const id of absent) if (!Object.hasOwn(prompts.drafts, id) && !Object.hasOwn(prompts.attachments, id)) absent.delete(id)
  if (absent.size) {
    recoverDeletedWorkspacePrompts(instanceId, prompts, absent)
    for (const id of absent) removeSessionRuntimeState(instanceId, id, "observation")
  }
  recoverDeletedWorkspacePrompts(instanceId, prompts)
  sessions = getSessions(instanceId)
  const validIds = new Set(sessions.map(({ id }) => id))
  selection = resolveRestoredSessionSelection(sessions, snapshot.activeParentSessionId, snapshot.activeSessionId)
  const unavailable = getUnavailableRestoredSessionIds(sessions, {
    activeParentSessionId: snapshot.activeParentSessionId, activeSessionId: snapshot.activeSessionId,
    draftSessionIds: Object.keys(prompts.drafts), attachmentSessionIds: Object.keys(prompts.attachments),
    scrollSessionIds: Object.keys(snapshot.scrollSnapshots), idleMarkerSessionIds: Object.keys(snapshot.unseenIdleSince),
    generationRecoverySessionIds: [...Object.keys(snapshot.generationRecovery), ...Object.keys(snapshot.seenInterruptions ?? {})],
    expandedSessionIds: snapshot.expandedSessionIds ?? [],
  }, [...getAuthoritativelyDeletedSessionIdsForInstance(instanceId),
    ...Object.keys(snapshot.drafts).filter(isLocalDraftId), ...Object.keys(snapshot.attachments).filter(isLocalDraftId)])
  hydrateWorkspacePromptState(instanceId, prompts, validIds, NO_SESSION_DRAFT_SESSION_ID)
  hydrateSessionIdleMarkers(instanceId, snapshot.unseenIdleSince)
  hydrateSessionGenerationRecovery(instanceId, snapshot.generationRecovery)
  const expandedSessionIds = snapshot.expandedSessionIds ?? (!hasAuthoritativeSessionSelection(instanceId) && selection?.activeSessionId
    ? getSessionAncestorIdsFromMap(new Map(sessions.map((session) => [session.id, session])), selection.activeSessionId)
    : [])
  hydrateSessionExpansion(instanceId, expandedSessionIds)
  if (!hasAuthoritativeSessionSelection(instanceId)) hydrateSelection()
  return unavailable
}
