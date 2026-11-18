import { batch } from "solid-js"
import { generateUUID } from "../lib/client-identity"
import { tGlobal } from "../lib/i18n"
import { showToastNotification } from "../lib/notifications"
import { clearAttachments, getAttachments, getSessionAttachmentsForInstance, setDraftAttachments } from "./attachments"
import { isRecoveredDraftId, NO_SESSION_DRAFT_SESSION_ID as composer, RECOVERED_DRAFT_PREFIX } from "./local-draft-ids"
import { clearSessionDraftPrompt, getSessionDraftPrompt, getSessionDraftPromptsForInstance, replaceSessionDraftPrompt, setSessionDraftPrompt } from "./session-state"

export function recoverRemovedSessionDraft(instanceId: string, sessionId: string) {
  if (isRecoveredDraftId(sessionId) || sessionId === composer) return
  const text = getSessionDraftPrompt(instanceId, sessionId)
  const attachments = getAttachments(instanceId, sessionId)
  if (!text && !attachments.length) return
  // Keep authored text and its references together under the existing per-draft budget.
  const occupied = Boolean(getSessionDraftPrompt(instanceId, composer) || getAttachments(instanceId, composer).length)
  const target = occupied ? RECOVERED_DRAFT_PREFIX + generateUUID() : composer
  batch(() => {
    replaceSessionDraftPrompt(instanceId, target, text)
    setDraftAttachments(instanceId, target, attachments)
    clearSessionDraftPrompt(instanceId, sessionId)
    clearAttachments(instanceId, sessionId)
  })
  showToastNotification({ category: "projects", variant: "warning", message: tGlobal("sessionState.cleanup.draftRecovered") })
}

export function recoveredDraftIds(instanceId: string) {
  return [...new Set([
    ...Object.keys(getSessionDraftPromptsForInstance(instanceId)),
    ...Object.keys(getSessionAttachmentsForInstance(instanceId)),
  ])].filter(isRecoveredDraftId).sort()
}

export function switchRecoveredDraft(instanceId: string, id: string) {
  if (!isRecoveredDraftId(id)) return
  const text = getSessionDraftPrompt(instanceId, id)
  const attachments = getAttachments(instanceId, id)
  if (!text && !attachments.length) return
  batch(() => {
    setSessionDraftPrompt(instanceId, id, getSessionDraftPrompt(instanceId, composer))
    setDraftAttachments(instanceId, id, getAttachments(instanceId, composer))
    replaceSessionDraftPrompt(instanceId, composer, text)
    setDraftAttachments(instanceId, composer, attachments)
  })
}
