import { batch } from "solid-js"
import type { RestorableWorkspaceTabState } from "./client-state-codec"
import { hydrateRestorableAttachment } from "./client-state-attachments-codec"
import { hydrateSessionAttachments } from "./attachments"
import { hydrateSessionDraftPrompt } from "./sessions"

export function hydrateWorkspacePromptState(
  instanceId: string,
  snapshot: Pick<RestorableWorkspaceTabState, "drafts" | "attachments">,
  validSessionIds: ReadonlySet<string>,
  noSessionDraftSessionId: string,
): void {
  const canHydrate = (sessionId: string) =>
    validSessionIds.has(sessionId) || sessionId === noSessionDraftSessionId

  batch(() => {
    // Mounted prompt synchronization requires placeholders to exist before attachments publish.
    for (const [sessionId, draft] of Object.entries(snapshot.drafts)) {
      if (!draft || !canHydrate(sessionId)) continue
      hydrateSessionDraftPrompt(instanceId, sessionId, draft)
    }
    for (const [sessionId, attachments] of Object.entries(snapshot.attachments)) {
      if (!canHydrate(sessionId)) continue
      hydrateSessionAttachments(
        instanceId,
        sessionId,
        attachments.map(hydrateRestorableAttachment).filter((value) => value !== null),
      )
    }
  })
}
