import { batch } from "solid-js"
import type { RestorableWorkspaceTabState } from "./client-state-codec"
import { hydrateRestorableAttachment } from "./client-state-attachments-codec"
import { getAuthoritativeAttachmentSessionIdsForInstance, hydrateSessionAttachments } from "./attachments"
import { getAuthoritativeDraftSessionIdsForInstance, hydrateSessionDraftPrompt } from "./sessions"

export function hydrateWorkspacePromptState(
  instanceId: string,
  snapshot: Pick<RestorableWorkspaceTabState, "drafts" | "attachments">,
  validSessionIds: ReadonlySet<string>,
  noSessionDraftSessionId: string,
): void {
  const canHydrate = (sessionId: string) =>
    validSessionIds.has(sessionId) || sessionId === noSessionDraftSessionId
  const authoritativeDrafts = getAuthoritativeDraftSessionIdsForInstance(instanceId)
  const authoritativeAttachments = getAuthoritativeAttachmentSessionIdsForInstance(instanceId)

  batch(() => {
    // Mounted prompt synchronization requires placeholders to exist before attachments publish.
    for (const [sessionId, draft] of Object.entries(snapshot.drafts)) {
      if (!draft || !canHydrate(sessionId)) continue
      if (authoritativeDrafts.has(sessionId)) continue
      hydrateSessionDraftPrompt(instanceId, sessionId, draft)
    }
    for (const [sessionId, attachments] of Object.entries(snapshot.attachments)) {
      if (!canHydrate(sessionId)) continue
      if (authoritativeAttachments.has(sessionId)) continue
      hydrateSessionAttachments(
        instanceId,
        sessionId,
        attachments.map(hydrateRestorableAttachment).filter((value) => value !== null),
      )
    }
  })
}
