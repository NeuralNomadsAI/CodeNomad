import { Show, createMemo, createEffect, type Component } from "solid-js"
import type { Session } from "../../types/session"
import type { Attachment } from "../../types/attachment"
import type { ClientPart } from "../../types/message"
import MessageSection from "../message-section"
import ActivityStatusLine from "../activity-status-line"
import InstructionCaptureCard from "../instruction-capture-card"
import { messageStoreBus } from "../../stores/message-v2/bus"
import PromptInput from "../prompt-input"
import { instances } from "../../stores/instances"
import { loadMessages, sendMessage, forkSession, isSessionMessagesLoading, setActiveParentSession, setActiveSession, runShellCommand, abortSession, getSessions } from "../../stores/sessions"
import { getActiveQuestion } from "../../stores/question-store"
import { isSessionBusy as getSessionBusyStatus } from "../../stores/session-status"
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
  forceCompactStatusLayout?: boolean
  isActive?: boolean
  isSubAgentSession?: boolean
  parentSessionTitle?: string
  onReturnToParent?: () => void
}

export const SessionView: Component<SessionViewProps> = (props) => {
  const session = () => props.activeSessions.get(props.sessionId)
  const messagesLoading = createMemo(() => isSessionMessagesLoading(props.instanceId, props.sessionId))
  const messageStore = createMemo(() => messageStoreBus.getOrCreate(props.instanceId))
  const sessionBusy = createMemo(() => {
    const currentSession = session()
    if (!currentSession) return false
    return getSessionBusyStatus(props.instanceId, currentSession.id)
  })

  // Detect if there's an active question from the question store
  const hasActiveQuestion = createMemo(() => {
    return !!getActiveQuestion(props.instanceId, props.sessionId)
  })

  // Compute sub-agent state from session data
  const isSubAgentSession = createMemo(() => {
    // Use prop if provided, otherwise compute from session data
    if (props.isSubAgentSession !== undefined) return props.isSubAgentSession
    const currentSession = session()
    return currentSession?.parentId !== null && currentSession?.title?.includes("subagent)")
  })

  const parentSession = createMemo(() => {
    const currentSession = session()
    if (!currentSession?.parentId) return null
    const allSessions = getSessions(props.instanceId)
    return allSessions.find(s => s.id === currentSession.parentId) || null
  })

  const parentSessionTitle = createMemo(() => {
    if (props.parentSessionTitle) return props.parentSessionTitle
    const parent = parentSession()
    return parent?.title || "parent session"
  })

  const handleReturnToParent = () => {
    if (props.onReturnToParent) {
      props.onReturnToParent()
      return
    }
    // Default: return to parent session
    const parent = parentSession()
    if (parent) {
      setActiveSession(props.instanceId, parent.id)
    }
  }
  let scrollToBottomHandle: (() => void) | undefined
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
  let quoteHandler: ((text: string, mode: "quote" | "code") => void) | null = null
 
  createEffect(() => {
    const currentSession = session()
    if (currentSession) {
      loadMessages(props.instanceId, currentSession.id).catch((error) => log.error("Failed to load messages", error))
    }
  })

  function registerQuoteHandler(handler: (text: string, mode: "quote" | "code") => void) {
    quoteHandler = handler
    return () => {
      if (quoteHandler === handler) {
        quoteHandler = null
      }
    }
  }

  function handleQuoteSelection(text: string, mode: "quote" | "code") {
    if (quoteHandler) {
      quoteHandler(text, mode)
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
      showAlertDialog("Failed to stop session", {
        title: "Stop failed",
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
          <div class="text-center text-muted-foreground">Session not found</div>
        </div>
      }
    >
      {(sessionAccessor) => {
        const activeSession = sessionAccessor()
        if (!activeSession) return null
        return (
          <div class="flex flex-1 min-h-0 flex-col bg-background overflow-hidden">
            <MessageSection
               instanceId={props.instanceId}
               sessionId={activeSession.id}
               loading={messagesLoading()}
               isSessionBusy={sessionBusy()}
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

            <ActivityStatusLine
              instanceId={props.instanceId}
              sessionId={activeSession.id}
              store={messageStore}
            />

            <InstructionCaptureCard />

            <PromptInput
              instanceId={props.instanceId}
              instanceFolder={props.instanceFolder}
              sessionId={activeSession.id}
              onSend={handleSendMessage}
              onRunShell={handleRunShell}
              escapeInDebounce={props.escapeInDebounce}
              isSessionBusy={sessionBusy()}
              onAbortSession={handleAbortSession}
              registerQuoteHandler={registerQuoteHandler}
              isSubAgentSession={isSubAgentSession()}
              parentSessionTitle={parentSessionTitle()}
              onReturnToParent={handleReturnToParent}
              hasActiveQuestion={hasActiveQuestion()}
            />
          </div>
        )
      }}
    </Show>
  )
}

export default SessionView
