import { Show, createMemo, createEffect, type Component } from "solid-js"
import type { Session } from "../../types/session"
import type { Attachment } from "../../types/attachment"
import type { ClientPart } from "../../types/message"
import MessageSection from "../message-section"
import { messageStoreBus } from "../../stores/message-v2/bus"
import PromptInput from "../prompt-input"
import { instances } from "../../stores/instances"
import { loadMessages, sendMessage, forkSession, isSessionMessagesLoading, setActiveParentSession, setActiveSession, runShellCommand } from "../../stores/sessions"
import { showAlertDialog } from "../../stores/alerts"
import { getLogger } from "../../lib/logger"

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
}

export const SessionView: Component<SessionViewProps> = (props) => {
  const session = () => props.activeSessions.get(props.sessionId)
  const messagesLoading = createMemo(() => isSessionMessagesLoading(props.instanceId, props.sessionId))
  const messageStore = createMemo(() => messageStoreBus.getOrCreate(props.instanceId))
  let scrollToBottomHandle: (() => void) | undefined
 
   createEffect(() => {

    const currentSession = session()
    if (currentSession) {
      loadMessages(props.instanceId, currentSession.id).catch((error) => log.error("Failed to load messages", error))
    }
  })

  async function handleSendMessage(prompt: string, attachments: Attachment[]) {
    if (scrollToBottomHandle) {
      scrollToBottomHandle()
    }
    await sendMessage(props.instanceId, props.sessionId, prompt, attachments)
  }

  async function handleRunShell(command: string) {
    await runShellCommand(props.instanceId, props.sessionId, command)
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
      await instance.client.session.revert({
        path: { id: props.sessionId },
        body: { messageID: messageId },
      })

      const restoredText = getUserMessageText(messageId)
      if (restoredText) {
        const textarea = document.querySelector(".prompt-input") as HTMLTextAreaElement
        if (textarea) {
          textarea.value = restoredText
          textarea.dispatchEvent(new Event("input", { bubbles: true }))
          textarea.focus()
        }
      }
    } catch (error) {
      log.error("Failed to revert message", error)
      showAlertDialog("Failed to revert to message", {
        title: "Revert failed",
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

    try {
      const forkedSession = await forkSession(props.instanceId, props.sessionId, { messageId })

      const parentToActivate = forkedSession.parentId ?? forkedSession.id
      setActiveParentSession(props.instanceId, parentToActivate)
      if (forkedSession.parentId) {
        setActiveSession(props.instanceId, forkedSession.id)
      }

      await loadMessages(props.instanceId, forkedSession.id).catch((error) => log.error("Failed to load forked session messages", error))

      if (restoredText) {
        const textarea = document.querySelector(".prompt-input") as HTMLTextAreaElement
        if (textarea) {
          textarea.value = restoredText
          textarea.dispatchEvent(new Event("input", { bubbles: true }))
          textarea.focus()
        }
      }
    } catch (error) {
      log.error("Failed to fork session", error)
      showAlertDialog("Failed to fork session", {
        title: "Fork failed",
        variant: "error",
      })
    }
  }


  return (
    <Show
      when={session()}
      fallback={
        <div class="flex items-center justify-center h-full">
          <div class="text-center text-gray-500">Session not found</div>
        </div>
      }
    >
      {(sessionAccessor) => {
        const activeSession = sessionAccessor()
        if (!activeSession) return null
        return (
          <div class="session-view">
            <MessageSection
               instanceId={props.instanceId}
               sessionId={activeSession.id}
               loading={messagesLoading()}
               onRevert={handleRevert}
               onFork={handleFork}
               registerScrollToBottom={(fn) => {
                 scrollToBottomHandle = fn
               }}
               showSidebarToggle={props.showSidebarToggle}
               onSidebarToggle={props.onSidebarToggle}
             />


            <PromptInput
              instanceId={props.instanceId}
              instanceFolder={props.instanceFolder}
              sessionId={activeSession.id}
              onSend={handleSendMessage}
              onRunShell={handleRunShell}
              escapeInDebounce={props.escapeInDebounce}
            />
          </div>
        )
      }}
    </Show>
  )
}

export default SessionView
