import { batch } from "solid-js"
import type { RestorableWorkspaceTabState } from "./client-state-codec"
import { hydrateRestorableAttachment } from "./client-state-attachments-codec"
import { getAttachments, getAuthoritativeAttachmentSessionIdsForInstance, hydrateSessionAttachments } from "./attachments"
import { getAuthoritativeDraftSessionIdsForInstance, hydrateSessionDraftPrompt } from "./sessions"
import { isLocalDraftId, isRecoveredDraftId, NO_SESSION_DRAFT_SESSION_ID } from "./local-draft-ids"
import { getAuthoritativelyDeletedSessionIdsForInstance, getSessionDraftPrompt } from "./session-state"
import { recoverRemovedSessionDraft } from "./session-draft-recovery"

type SavedPrompts = Pick<RestorableWorkspaceTabState, "drafts" | "attachments">

export function currentDraftAbsences(proofs: ReadonlyMap<string, () => boolean>) {
  return new Set([...proofs].filter(([, current]) => current()).map(([id]) => id))
}

/** Transfer before the source tombstone can purge persisted fallback data. */
export function recoverDeletedWorkspacePrompts(
  instanceId: string,
  snapshot: SavedPrompts,
  confirmedAbsent: ReadonlySet<string> = getAuthoritativelyDeletedSessionIdsForInstance(instanceId),
): ReadonlySet<string> | undefined {
  if (!confirmedAbsent.size) return
  const content = new Set([...Object.keys(snapshot.drafts), ...Object.keys(snapshot.attachments)])
  const targets = new Set([...confirmedAbsent].filter(id => content.has(id) && !isLocalDraftId(id)))
  if (!targets.size) return
  batch(() => {
    // An early flush can reach this before the ordinary composer is hydrated.
    hydrateWorkspacePromptState(instanceId, snapshot, targets, NO_SESSION_DRAFT_SESSION_ID, true)
    for (const id of targets) recoverRemovedSessionDraft(instanceId, id)
  })
  return targets
}

export function hydrateWorkspacePromptState(
  instanceId: string,
  snapshot: SavedPrompts,
  validSessionIds: ReadonlySet<string>,
  noSessionDraftSessionId: string,
  keepLive = false,
): ReadonlySet<string> {
  const canHydrate = (sessionId: string) =>
    validSessionIds.has(sessionId) || sessionId === noSessionDraftSessionId || isRecoveredDraftId(sessionId)
  const authoritativeDrafts = getAuthoritativeDraftSessionIdsForInstance(instanceId)
  const authoritativeAttachments = getAuthoritativeAttachmentSessionIdsForInstance(instanceId)
  const applied = new Set<string>()

  batch(() => {
    // Mounted prompt synchronization requires placeholders to exist before attachments publish.
    for (const [sessionId, draft] of Object.entries(snapshot.drafts)) {
      if (!draft || !canHydrate(sessionId)) continue
      if (authoritativeDrafts.has(sessionId) || (keepLive && getSessionDraftPrompt(instanceId, sessionId))) continue
      hydrateSessionDraftPrompt(instanceId, sessionId, draft)
      applied.add(sessionId)
    }
    for (const [sessionId, attachments] of Object.entries(snapshot.attachments)) {
      if (!canHydrate(sessionId)) continue
      if (authoritativeAttachments.has(sessionId) || (keepLive && getAttachments(instanceId, sessionId).length)) continue
      const hydrated = attachments.map(hydrateRestorableAttachment).filter((value) => value !== null)
      hydrateSessionAttachments(instanceId, sessionId, hydrated)
      if (hydrated.length) applied.add(sessionId)
    }
  })
  return applied
}
