import type { RestorableWorkspaceTabState } from "./client-state-codec"
import { getUnavailableRestoredSessionIds, resolveRestoredSessionSelection } from "./app-session-reconciliation"
import { getAbortReason } from "./app-session-restore-timeout"
import { getRestoredSessionIds } from "./app-session-restored-session-ids"
import { hydrateWorkspacePromptState } from "./app-session-prompt-hydration"
import { MESSAGE_STREAM_SCROLL_SCOPE, messageStoreBus, type MessageScrollSnapshotSeed } from "./message-v2/bus"
import { getSessionAncestorIdsFromMap } from "./session-tree"
import { seedRestoredSessionSelection } from "./session-state"
import { seedSessionOutlineIndexes } from "./session-outline"
import { seedSessionCatalog } from "./session-catalog-hydration"
import { hydrateSeenInterruptions } from "./session-interruption-seen"
import { instances } from "./instances"
import { projectIdentity } from "../lib/project-identity"
import { explicitSessionDirectory } from "./session-inventory-scope"
import { getOpenCodeInstanceGeneration } from "./opencode-data"
import {
  getSessions, hasAuthoritativeSessionSelection, hydrateActiveSessionSelection,
  hydrateRestoredSessionChain, hydrateSessionExpansion, hydrateSessionGenerationRecovery, hydrateSessionIdleMarkers,
} from "./sessions"

export const NO_SESSION_DRAFT_SESSION_ID = "__no_session_draft__"

export function seedRestoredWorkspaceState(
  instanceId: string,
  snapshot: RestorableWorkspaceTabState,
): void {
  const instance = instances().get(instanceId)
  if (instance && projectIdentity(instance.folder, instance.binding?.serverId) !== projectIdentity(snapshot.folder, snapshot.serverId)) return
  const scrollSeeds: MessageScrollSnapshotSeed[] = Object.entries(snapshot.scrollSnapshots)
    .map(([sessionId, scrollSnapshot]) => ({ sessionId, scope: MESSAGE_STREAM_SCROLL_SCOPE, snapshot: scrollSnapshot }))
  messageStoreBus.seedScrollSnapshots(instanceId, scrollSeeds)
  seedSessionOutlineIndexes(instanceId, snapshot.outlineIndexes)
  seedSessionCatalog(instanceId, snapshot.sessionCatalog)
  hydrateSessionIdleMarkers(instanceId, snapshot.unseenIdleSince)
  hydrateSessionGenerationRecovery(instanceId, snapshot.generationRecovery)
  hydrateSeenInterruptions(instanceId, snapshot.seenInterruptions)
  if (snapshot.expandedSessionIds !== undefined) hydrateSessionExpansion(instanceId, snapshot.expandedSessionIds)
  hydrateWorkspacePromptState(instanceId, snapshot, new Set(getSessions(instanceId).map(session => session.id)), NO_SESSION_DRAFT_SESSION_ID)
  seedRestoredSessionSelection(instanceId, snapshot.activeParentSessionId ?? null, snapshot.activeSessionId ?? snapshot.activeParentSessionId ?? null)
}

export async function hydrateRestoredWorkspaceState(
  instanceId: string,
  snapshot: RestorableWorkspaceTabState,
  signal: AbortSignal,
  isCurrentBinding: () => boolean,
): Promise<Set<string> | null> {
  const instance = instances().get(instanceId)
  const client = instance?.client
  const generation = getOpenCodeInstanceGeneration(instanceId)
  const current = isCurrentBinding
  isCurrentBinding = () => {
    const live = instances().get(instanceId)
    return Boolean(live && live.client === client && getOpenCodeInstanceGeneration(instanceId) === generation && current()
      && projectIdentity(live.folder, live.binding?.serverId) === projectIdentity(snapshot.folder, snapshot.serverId))
  }
  if (signal.aborted) throw getAbortReason(signal)
  if (!isCurrentBinding()) return null
  // Session selection mounts MessageSection synchronously. Seed scroll state
  // first so its initial restore cannot mistake an unavailable snapshot for a
  // deliberate at-bottom state.
  seedRestoredWorkspaceState(instanceId, snapshot)
  await hydrateRestoredSessionChain(instanceId, [snapshot.activeParentSessionId, snapshot.activeSessionId], signal, isCurrentBinding)
  if (signal.aborted) throw getAbortReason(signal)
  if (!isCurrentBinding()) return null
  let sessions = getSessions(instanceId)
  const resolveSelection = () => {
    const ids = new Set(sessions.map(session => session.id))
    const candidates = explicitSessionDirectory(instances().get(instanceId)) === undefined ? sessions
      : sessions.map(session => ({ id: session.id, parentId: session.parentId && ids.has(session.parentId) ? session.parentId : null }))
    return resolveRestoredSessionSelection(candidates, snapshot.activeParentSessionId, snapshot.activeSessionId)
  }
  let selection = resolveSelection()
  if (!hasAuthoritativeSessionSelection(instanceId)) {
    hydrateActiveSessionSelection(instanceId, selection?.parentSessionId ?? null, selection?.activeSessionId ?? null)
  }
  hydrateWorkspacePromptState(
    instanceId,
    snapshot,
    new Set(sessions.map(({ id }) => id)),
    NO_SESSION_DRAFT_SESSION_ID,
  )

  await hydrateRestoredSessionChain(instanceId, getRestoredSessionIds([
    Object.keys(snapshot.drafts),
    Object.keys(snapshot.attachments),
  ]), signal, isCurrentBinding)
  if (signal.aborted) throw getAbortReason(signal)
  if (!isCurrentBinding()) return null
  sessions = getSessions(instanceId)
  const validIds = new Set(sessions.map(({ id }) => id))
  selection = resolveSelection()
  const unavailable = getUnavailableRestoredSessionIds(sessions, {
    activeParentSessionId: snapshot.activeParentSessionId, activeSessionId: snapshot.activeSessionId,
    draftSessionIds: Object.keys(snapshot.drafts), attachmentSessionIds: Object.keys(snapshot.attachments),
    scrollSessionIds: Object.keys(snapshot.scrollSnapshots), idleMarkerSessionIds: Object.keys(snapshot.unseenIdleSince),
    generationRecoverySessionIds: [...Object.keys(snapshot.generationRecovery), ...Object.keys(snapshot.seenInterruptions ?? {})],
    expandedSessionIds: snapshot.expandedSessionIds ?? [],
  }, [NO_SESSION_DRAFT_SESSION_ID])
  hydrateWorkspacePromptState(instanceId, snapshot, validIds, NO_SESSION_DRAFT_SESSION_ID)
  hydrateSessionIdleMarkers(instanceId, snapshot.unseenIdleSince)
  hydrateSessionGenerationRecovery(instanceId, snapshot.generationRecovery)
  const expandedSessionIds = snapshot.expandedSessionIds ?? (!hasAuthoritativeSessionSelection(instanceId) && selection?.activeSessionId
    ? getSessionAncestorIdsFromMap(new Map(sessions.map((session) => [session.id, session])), selection.activeSessionId)
    : [])
  hydrateSessionExpansion(instanceId, expandedSessionIds)
  if (!hasAuthoritativeSessionSelection(instanceId)) hydrateActiveSessionSelection(instanceId, selection?.parentSessionId ?? null, selection?.activeSessionId ?? null)
  return unavailable
}
