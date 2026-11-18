import { batch } from "solid-js"
import { createAttachmentPlaceholderRegex, getAttachmentPlaceholder } from "../lib/attachment-placeholders"
import { tGlobal } from "../lib/i18n"
import { showToastNotification } from "../lib/notifications"
import { NO_SESSION_DRAFT_SESSION_ID } from "./app-session-workspace-hydration"
import { addAttachment, getAttachments } from "./attachments"
import { getSessionDraftPrompt, setSessionDraftPrompt } from "./session-state"

/** Move unsent material into the tab's existing, restorable new-conversation draft. */
export function recoverRemovedSessionDraft(instanceId: string, sessionId: string) {
  let text = getSessionDraftPrompt(instanceId, sessionId)
  const attachments = getAttachments(instanceId, sessionId)
  if (!text && !attachments.length) return
  const target = NO_SESSION_DRAFT_SESSION_ID
  const draft = getSessionDraftPrompt(instanceId, target)
  const reserved = new Set<string>()
  for (const kind of ["image", "pasted"] as const) {
    for (const match of `${draft}\n${text}`.matchAll(createAttachmentPlaceholderRegex(kind))) reserved.add(`${kind}:${match[1]}`)
  }
  const existing = getAttachments(instanceId, target)
  for (const entry of [...existing, ...attachments]) {
    const token = getAttachmentPlaceholder(entry.display)
    if (token) reserved.add(`${token.kind}:${token.counter}`)
  }
  batch(() => {
    for (const entry of attachments) {
      const token = getAttachmentPlaceholder(entry.display)
      if (!token) {
        if (!existing.some(value => value.id === entry.id)) addAttachment(instanceId, target, entry)
        continue
      }
      let index = 1
      while (reserved.has(`${token.kind}:${index}`)) index++
      reserved.add(`${token.kind}:${index}`)
      const display = `${token.kind === "image" ? "Image" : "pasted"} #${index}`
      text = text.replace(createAttachmentPlaceholderRegex(token.kind, token.counter), `[${display}]`)
      addAttachment(instanceId, target, { ...entry, display })
    }
    setSessionDraftPrompt(instanceId, target, [draft, text].filter(Boolean).join("\n\n"))
  })
  showToastNotification({ category: "projects", variant: "warning", message: tGlobal("sessionState.cleanup.draftRecovered") })
}
