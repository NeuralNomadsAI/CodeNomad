import { Show, createMemo, createEffect, on, type Component } from "solid-js"
import type { Session } from "../../types/session"
import type { Attachment } from "../../types/attachment"
import type { ClientPart } from "../../types/message"
import MessageSection from "../message-section"
import { messageStoreBus } from "../../stores/message-v2/bus"
import PromptInput from "../prompt-input"
import PromptAttachmentsBar from "../prompt-input/PromptAttachmentsBar"
import { getAttachments, removeAttachment } from "../../stores/attachments"
import { instances } from "../../stores/instances"
import { loadMessages, sendMessage, forkSession, renameSession, isSessionMessagesLoading, setActiveParentSession, setActiveSession, runShellCommand, abortSession } from "../../stores/sessions"
import { isSessionBusy as getSessionBusyStatus } from "../../stores/session-status"
import { showAlertDialog } from "../../stores/alerts"
import { getLogger } from "../../lib/logger"
import { requestData } from "../../lib/opencode-api"
import { useI18n } from "../../lib/i18n"
import type { PromptInputApi, PromptInsertMode } from "../prompt-input/types"

const log = getLogger("session")

function isTextPart(part: ClientPart): part is ClientPart & { type: "text"; text: string } {
  return part?.type === "text" && typeof (part as any).text === "string"
}

interface SessionViewProps {
  sessionId: string
  activeSessions: Map<string, Session>
  instanceId: string
  instanceFolder: string
  escapeInDebounce: boolean
  showSidebarToggle?: boolean
  onSidebarToggle?: () => void
  forceCompactStatusLayout?: boolean
  isActive?: boolean
}

export const SessionView: Component<SessionViewProps> = (props) => {
  const { t } = useI18n()
  const session = () => props.activeSessions.get(props.sessionId)
  const messagesLoading = createMemo(() => isSessionMessagesLoading(props.instanceId, props.sessionId))
  const messageStore = createMemo(() => messageStoreBus.getOrCreate(props.instanceId))
  const sessionBusy = createMemo(() => {
    const currentSession = session()
    if (!currentSession) return false
    return getSessionBusyStatus(props.instanceId, currentSession.id)
  })

  const sessionNeedsInput = createMemo(() => {
    const currentSession = session()
    if (!currentSession) return false
    return Boolean(currentSession.pendingPermission || (currentSession as any).pendingQuestion)
  })

  const attachments = createMemo(() => getAttachments(props.instanceId, props.sessionId))

  let promptInputApi: PromptInputApi | null = null
  let pendingPromptText: string | null = null
  let pendingSelectionInsert: { text: string; mode: PromptInsertMode } | null = null

  let scrollToBottomHandle: (() => void) | undefined
  let rootRef: HTMLDivElement | undefined
  function scheduleScrollToBottom() {
    if (!scrollToBottomHandle) return
    requestAnimationFrame(() => {
      requestAnimationFrame(() => scrollToBottomHandle?.())
    })
  }
  createEffect(() => {
    if (!props.isActive) return
    scheduleScrollToBottom()
  })

  createEffect(
    on(
      () => props.isActive,
      (isActive) => {
        if (!isActive) return

        // Don't steal focus from other inputs (command palette, dialogs, selectors, etc.)
        if (typeof document === "undefined") return
        const activeEl = document.activeElement as HTMLElement | null
        const activeIsInput =
          activeEl?.tagName === "INPUT" ||
          activeEl?.tagName === "TEXTAREA" ||
          activeEl?.tagName === "SELECT" ||
          Boolean(activeEl?.isContentEditable)
        if (activeIsInput) return

        const modalOpen = Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'))
        if (modalOpen) return

        // Defer until the session pane is visible and the textarea is mounted.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (promptInputApi) {
              promptInputApi.focus()
              return
            }

            const textarea = rootRef?.querySelector<HTMLTextAreaElement>(".prompt-input")
            if (!textarea) return
            if (textarea.disabled) return

            try {
              textarea.focus({ preventScroll: true } as any)
            } catch {
              textarea.focus()
            }
          })
        })
      },
    ),
  )

  createEffect(() => {
    const currentSession = session()
    if (currentSession) {
      loadMessages(props.instanceId, currentSession.id).catch((error) => log.error("Failed to load messages", error))
    }
  })

  function registerPromptInputApi(api: PromptInputApi) {
    promptInputApi = api

    if (pendingPromptText) {
      api.setPromptText(pendingPromptText, { focus: true })
      pendingPromptText = null
    }

    if (pendingSelectionInsert) {
      api.insertSelection(pendingSelectionInsert.text, pendingSelectionInsert.mode)
      pendingSelectionInsert = null
    }

    return () => {
      if (promptInputApi === api) {
        promptInputApi = null
      }
    }
  }

  function handleQuoteSelection(text: string, mode: PromptInsertMode) {
    if (promptInputApi) {
      promptInputApi.insertSelection(text, mode)
    } else {
      pendingSelectionInsert = { text, mode }
    }
  }
 
  async function handleSendMessage(prompt: string, attachments: Attachment[]) {
    scheduleScrollToBottom()
    await sendMessage(props.instanceId, props.sessionId, prompt, attachments)
  }

  async function handleRunShell(command: string) {
    await runShellCommand(props.instanceId, props.sessionId, command)
  }
 
  async function handleAbortSession() {
    const currentSession = session()
    if (!currentSession) return
 
    try {
      await abortSession(props.instanceId, currentSession.id)
      log.info("Abort requested", { instanceId: props.instanceId, sessionId: currentSession.id })
    } catch (error) {
      log.error("Failed to abort session", error)
      showAlertDialog(t("sessionView.alerts.abortFailed.message"), {
        title: t("sessionView.alerts.abortFailed.title"),
        detail: error instanceof Error ? error.message : String(error),
        variant: "error",
      })
    }
  }
 
  function getUserMessageText(messageId: string): string | null {

    const normalizedMessage = messageStore().getMessage(messageId)
    if (normalizedMessage && normalizedMessage.role === "user") {
      const parts = normalizedMessage.partIds
        .map((partId) => normalizedMessage.parts[partId]?.data)
        .filter((part): part is ClientPart => Boolean(part))
      const textParts = parts.filter(isTextPart)
      if (textParts.length > 0) {
        return textParts.map((part) => part.text).join("\n")
      }
    }
 
    return null
  }


  async function handleRevert(messageId: string) {
    const instance = instances().get(props.instanceId)
    if (!instance || !instance.client) return

    try {
      await requestData(
        instance.client.session.revert({
          sessionID: props.sessionId,
          messageID: messageId,
        }),
        "session.revert",
      )

      const restoredText = getUserMessageText(messageId)
       if (restoredText) {
         if (promptInputApi) {
           promptInputApi.setPromptText(restoredText, { focus: true })
         } else {
           pendingPromptText = restoredText
         }
       }
    } catch (error) {
      log.error("Failed to revert message", error)
      showAlertDialog(t("sessionView.alerts.revertFailed.message"), {
        title: t("sessionView.alerts.revertFailed.title"),
        variant: "error",
      })
    }
  }

  async function handleFork(messageId?: string) {
    if (!messageId) {
      log.warn("Fork requires a user message id")
      return
    }

    const restoredText = getUserMessageText(messageId)
    const parentTitle = (session()?.title ?? "").trim() || t("sessionList.session.untitled")

    try {
      const forkedSession = await forkSession(props.instanceId, props.sessionId, { messageId })

      renameSession(props.instanceId, forkedSession.id, `Fork: ${parentTitle}`).catch((error) => {
        log.error("Failed to rename forked session", error)
      })

      const parentToActivate = forkedSession.parentId ?? forkedSession.id
      setActiveParentSession(props.instanceId, parentToActivate)
      if (forkedSession.parentId) {
        setActiveSession(props.instanceId, forkedSession.id)
      }

      await loadMessages(props.instanceId, forkedSession.id).catch((error) => log.error("Failed to load forked session messages", error))

       if (restoredText) {
         if (promptInputApi) {
           promptInputApi.setPromptText(restoredText, { focus: true })
         } else {
           pendingPromptText = restoredText
         }
       }
    } catch (error) {
      log.error("Failed to fork session", error)
      showAlertDialog(t("sessionView.alerts.forkFailed.message"), {
        title: t("sessionView.alerts.forkFailed.title"),
        variant: "error",
      })
    }
  }


  return (
    <Show
      when={session()}
      fallback={
        <div class="flex items-center justify-center h-full">
          <div class="text-center text-gray-500">{t("sessionView.fallback.sessionNotFound")}</div>
        </div>
      }
    >
      {(sessionAccessor) => {
        const activeSession = sessionAccessor()
        if (!activeSession) return null
        return (
          <div ref={rootRef} class="session-view">
            <MessageSection
               instanceId={props.instanceId}
               sessionId={activeSession.id}
               loading={messagesLoading()}
               onRevert={handleRevert}
               onFork={handleFork}
               isActive={props.isActive}
                registerScrollToBottom={(fn) => {
                  scrollToBottomHandle = fn
                  if (props.isActive) {
                    scheduleScrollToBottom()
                  }
                }}




               showSidebarToggle={props.showSidebarToggle}
               onSidebarToggle={props.onSidebarToggle}
               forceCompactStatusLayout={props.forceCompactStatusLayout}
               onQuoteSelection={handleQuoteSelection}
             />


               <Show when={attachments().length > 0}>
                 <PromptAttachmentsBar
                   attachments={attachments()}
                   onRemoveAttachment={(attachmentId) => removeAttachment(props.instanceId, props.sessionId, attachmentId)}
                   onExpandTextAttachment={(attachmentId) => promptInputApi?.expandTextAttachment(attachmentId)}
                 />
               </Show>

              <PromptInput
               instanceId={props.instanceId}
               instanceFolder={props.instanceFolder}
               sessionId={activeSession.id}
               onSend={handleSendMessage}
               onRunShell={handleRunShell}
               escapeInDebounce={props.escapeInDebounce}
               isSessionBusy={sessionBusy()}
               disabled={sessionNeedsInput()}
               onAbortSession={handleAbortSession}
               registerPromptInputApi={registerPromptInputApi}
               />
            </div>
          )
        }}
    </Show>
  )
}

export default SessionView
