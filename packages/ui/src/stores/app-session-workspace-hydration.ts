import type { RestorableWorkspaceTabState } from "./client-state-codec"
import { getUnavailableRestoredSessionIds, resolveRestoredSessionSelection } from "./app-session-reconciliation"
import { getAbortReason } from "./app-session-restore-timeout"
import { hydrateWorkspacePromptState } from "./app-session-prompt-hydration"
import { messageStoreBus, type MessageScrollSnapshotSeed } from "./message-v2/bus"
import { getSessionAncestorIdsFromMap } from "./session-tree"
import {
  getSessions, hasAuthoritativeSessionSelection, hydrateActiveSessionSelection,
  hydrateRestoredSessionChain, hydrateSessionExpansion, hydrateSessionGenerationRecovery, hydrateSessionIdleMarkers,
} from "./sessions"

const MESSAGE_SCROLL_SCOPE = "message-stream"
export const NO_SESSION_DRAFT_SESSION_ID = "__no_session_draft__"

export async function hydrateRestoredWorkspaceState(
  instanceId: string,
  snapshot: RestorableWorkspaceTabState,
  signal: AbortSignal,
  isCurrentBinding: () => boolean,
): Promise<Set<string> | null> {
  await hydrateRestoredSessionChain(instanceId, [snapshot.activeParentSessionId, snapshot.activeSessionId], signal)
  if (signal.aborted) throw getAbortReason(signal)
  if (!isCurrentBinding()) return null
  const sessions = getSessions(instanceId)
  const validIds = new Set(sessions.map(({ id }) => id))
  const selection = resolveRestoredSessionSelection(sessions, snapshot.activeParentSessionId, snapshot.activeSessionId)
  const unavailable = getUnavailableRestoredSessionIds(sessions, {
    activeParentSessionId: snapshot.activeParentSessionId, activeSessionId: snapshot.activeSessionId,
    draftSessionIds: Object.keys(snapshot.drafts), attachmentSessionIds: Object.keys(snapshot.attachments),
    scrollSessionIds: Object.keys(snapshot.scrollSnapshots), idleMarkerSessionIds: Object.keys(snapshot.unseenIdleSince),
    generationRecoverySessionIds: Object.keys(snapshot.generationRecovery),
    expandedSessionIds: snapshot.expandedSessionIds ?? [],
  }, [NO_SESSION_DRAFT_SESSION_ID])
  hydrateWorkspacePromptState(instanceId, snapshot, validIds, NO_SESSION_DRAFT_SESSION_ID)
  hydrateSessionIdleMarkers(instanceId, snapshot.unseenIdleSince)
  hydrateSessionGenerationRecovery(instanceId, snapshot.generationRecovery)
  const expandedSessionIds = snapshot.expandedSessionIds ?? (!hasAuthoritativeSessionSelection(instanceId) && selection?.activeSessionId
    ? getSessionAncestorIdsFromMap(new Map(sessions.map((session) => [session.id, session])), selection.activeSessionId)
    : [])
  hydrateSessionExpansion(instanceId, expandedSessionIds)
  const scrollSeeds: MessageScrollSnapshotSeed[] = Object.entries(snapshot.scrollSnapshots)
    .map(([sessionId, scrollSnapshot]) => ({ sessionId, scope: MESSAGE_SCROLL_SCOPE, snapshot: scrollSnapshot }))
  messageStoreBus.seedScrollSnapshots(instanceId, scrollSeeds)
  if (!hasAuthoritativeSessionSelection(instanceId)) {
    hydrateActiveSessionSelection(instanceId, selection?.parentSessionId ?? null, selection?.activeSessionId ?? null)
  }
  return unavailable
}
