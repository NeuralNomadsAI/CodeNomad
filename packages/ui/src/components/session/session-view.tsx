import { Show, createMemo, createEffect, createSignal, on, onCleanup, onMount, type Component } from "solid-js"
import type { SessionInboxUser } from "@opencode-ai/client"
import type { Session } from "../../types/session"
import type { Attachment } from "../../types/attachment"
import type { ClientPart } from "../../types/message"
import MessageSection from "../message-section"
import { messageStoreBus } from "../../stores/message-v2/bus"
import PromptInput from "../prompt-input"
import PromptAttachmentsBar from "../prompt-input/PromptAttachmentsBar"
import PromptQueue from "../prompt-queue"
import { getAttachments, hydrateSessionAttachments, removeAttachment } from "../../stores/attachments"
import { instances, waitForInstanceWorkspaceMetadataHydration } from "../../stores/instances"
import { getMessageNextCursor, hasMoreMessages, isLatestMessageWindow, loadLatestMessageWindow, loadMessages, loadMoreMessages, loadNewerMessageWindow, loadOldestMessageWindow, sendMessage, forkSession, renameSession, isSessionMessagesLoading, getSessionMessagesLoadError, markSessionIdleSeen, ensureSessionAncestorsExpanded, setActiveSessionFromList, runShellCommand, abortSession } from "../../stores/sessions"
import { canMarkSessionIdleSeen } from "./session-idle-attention"
import { clearSessionIdleFade, IDLE_STATUS_VISIBILITY_MS, getSessionStatus, isSessionBusy as getSessionBusyStatus, markSessionIdleFadeStarted } from "../../stores/session-status"
import { showAlertDialog } from "../../stores/alerts"
import { getLogger } from "../../lib/logger"
import { useActiveSessionMessageLoad } from "../../lib/hooks/use-active-session-message-load"
import { useI18n } from "../../lib/i18n"
import type { PromptDelivery, PromptInputApi, PromptInsertMode } from "../prompt-input/types"
import { clearConversationPlaybackForSession } from "../../stores/conversation-speech"
import { useConfig } from "../../stores/preferences"
import { closeSessionPreview, getSessionPreview, showSessionChat } from "../../stores/session-previews"
import { SessionPreviewView } from "../session-preview-view"
import { isSnapshotAutoFollowing } from "../virtual-follow-behavior"
import { getSubmitBottomPinTargetCount, resolveSessionBottomPinIntent, shouldClearSessionBottomPinIntent, type SessionBottomPinIntent } from "./session-bottom-pin-intent"
import { focusConversationStream } from "../focus-conversation"
import { getOpenCodeSessionInbox, syncOpenCodeSessionInbox } from "../../stores/opencode-data"

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
  isPhoneLayout?: boolean
  compactPromptLayout?: boolean
  focusConversationOnActivate?: boolean
  onConversationFocusHandled?: () => void
  showSidebarToggle?: boolean
  onSidebarToggle?: () => void
  forceCompactStatusLayout?: boolean
  isActive?: boolean
  registerSessionPromptApi?: (sessionId: string, api: PromptInputApi | null) => void
}

export const SessionView: Component<SessionViewProps> = (props) => {
  const [documentAttentionActive, setDocumentAttentionActive] = createSignal(false)

  onMount(() => {
    const updateDocumentAttention = () => setDocumentAttentionActive(canMarkSessionIdleSeen({
      active: true,
      visibilityState: document.visibilityState,
      focused: document.hasFocus(),
    }))
    updateDocumentAttention()
    window.addEventListener("focus", updateDocumentAttention)
    window.addEventListener("blur", updateDocumentAttention)
    document.addEventListener("visibilitychange", updateDocumentAttention)
    onCleanup(() => {
      window.removeEventListener("focus", updateDocumentAttention)
      window.removeEventListener("blur", updateDocumentAttention)
      document.removeEventListener("visibilitychange", updateDocumentAttention)
    })
  })
  const { t } = useI18n()
  const { preferences } = useConfig()
  const session = () => props.activeSessions.get(props.sessionId)
  const messagesLoading = createMemo(() => isSessionMessagesLoading(props.instanceId, props.sessionId))
  const messagesLoadError = createMemo(() => getSessionMessagesLoadError(props.instanceId, props.sessionId))
  const messageStore = createMemo(() => messageStoreBus.getOrCreate(props.instanceId))
  const sessionBusy = createMemo(() => {
    const currentSession = session()
    if (!currentSession) return false
    return getSessionBusyStatus(props.instanceId, currentSession.id)
  })
  const sessionStreamingActive = createMemo(() => {
    const currentSession = session()
    if (!currentSession) return false
    return getSessionStatus(props.instanceId, currentSession.id) === "working"
  })
  const sessionNeedsInput = createMemo(() => {
    const currentSession = session()
    if (!currentSession) return false
    return Boolean(currentSession.pendingPermission || currentSession.pendingForm)
  })

  const attachments = createMemo(() => getAttachments(props.instanceId, props.sessionId))
  const pendingUserPrompts = createMemo(() => getOpenCodeSessionInbox(props.instanceId, props.sessionId, props.instanceFolder)
    .filter((item): item is SessionInboxUser => item.type === "user"))
  const queuedPrompts = createMemo(() => pendingUserPrompts().filter((item) => item.delivery === "queue"))
  const queuedMessageIds = createMemo(() => new Set(queuedPrompts().map((item) => item.id)))
  const preview = createMemo(() => getSessionPreview(props.sessionId))

  const MESSAGE_SCROLL_CACHE_SCOPE = "message-stream"

  let promptInputApi: PromptInputApi | null = null
  let pendingPromptText: string | null = null
  let pendingSelectionInsert: { text: string; mode: PromptInsertMode } | null = null
  let pendingCommentText: string | null = null
  let queuedPromptEditStash: { prompt: string; attachments: Attachment[] } | null = null
  const [editingQueuedPrompt, setEditingQueuedPrompt] = createSignal<SessionInboxUser>()
  const [queueBusyId, setQueueBusyId] = createSignal<string>()

  createEffect(on(
    () => `${props.instanceId}:${props.sessionId}`,
    () => void syncOpenCodeSessionInbox(props.instanceId, props.sessionId, props.instanceFolder)
      .catch((error) => log.error("Failed to load prompt queue", error)),
  ))

  createEffect(() => {
    const editing = editingQueuedPrompt()
    if (!editing) return
    const current = queuedPrompts().find((item) => item.id === editing.id)
    if (!current) cancelQueuedPromptEdit()
    else if (current !== editing) setEditingQueuedPrompt(current)
  })

  let scrollToBottomHandle: (() => void) | undefined
  let rootRef: HTMLDivElement | undefined
  const pendingIdleSeenTimers = new Set<string>()
  const [submitBottomPinIntent, setSubmitBottomPinIntent] = createSignal<SessionBottomPinIntent | null>(null)
  let submitBottomPinIntentSequence = 0

  function visibleMessageCount() {
    const hidden = queuedMessageIds()
    return messageStore().getSessionMessageIds(props.sessionId).filter((id) => !hidden.has(id)).length
  }

  function shouldScrollToBottomOnActivate() {
    const current = session()
    if (!current) return true
    const snapshot = messageStore().getScrollSnapshot(current.id, MESSAGE_SCROLL_CACHE_SCOPE)
    return isSnapshotAutoFollowing(snapshot)
  }

  function scheduleScrollToBottom(options?: { force?: boolean; sessionId?: string }) {
    if (!scrollToBottomHandle) return false
    const targetSessionId = options?.sessionId ?? props.sessionId
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const current = session()
        if (!current || current.id !== targetSessionId) return
        if (!options?.force && !shouldScrollToBottomOnActivate()) return
        scrollToBottomHandle?.()
      })
    })
    return true
  }

  function startSubmitBottomPinIntent(
    minItemCount: number,
    options?: { createdMessageCount?: number; preserveObservedStreaming?: boolean },
  ) {
    submitBottomPinIntentSequence += 1
    const previous = submitBottomPinIntent()
    const createdMessageCount = options?.createdMessageCount ?? visibleMessageCount()
    const shouldPreserveObservedStreaming = Boolean(
      options?.preserveObservedStreaming &&
      previous?.sessionId === props.sessionId &&
      previous.createdMessageCount === createdMessageCount,
    )
    const intent: SessionBottomPinIntent = {
      sessionId: props.sessionId,
      token: submitBottomPinIntentSequence,
      minItemCount,
      createdMessageCount,
      observedStreaming: shouldPreserveObservedStreaming ? previous?.observedStreaming === true : false,
    }
    setSubmitBottomPinIntent(intent)
    return intent
  }

  function forceSubmittedExchangeToBottom(
    minItemCount: number,
    options?: { createdMessageCount?: number; preserveObservedStreaming?: boolean },
  ) {
    const intent = startSubmitBottomPinIntent(minItemCount, options)
    scrollToBottomHandle?.()
    return intent
  }

  const activeSubmitBottomPinIntent = createMemo(() => {
    const intent = submitBottomPinIntent()
    const currentSession = session()
    if (!intent || !currentSession) return null

    const messageCount = visibleMessageCount()
    if (shouldClearSessionBottomPinIntent(intent, {
      sessionId: currentSession.id,
      messageCount,
      streamingActive: sessionStreamingActive(),
    })) {
      return null
    }

    return resolveSessionBottomPinIntent(intent, currentSession.id)
  })

  function getSeenIdleEntries(currentSession: Session, keepUnseenSubagentIdleStatus: boolean): Array<{ id: string; idleSince: number }> {
    const entries: Array<{ id: string; idleSince: number }> = []

    if (currentSession.status === "idle" && typeof currentSession.idleSince === "number") {
      entries.push({ id: currentSession.id, idleSince: currentSession.idleSince })
    }

    if (currentSession.parentId === null && !keepUnseenSubagentIdleStatus) {
      for (const child of props.activeSessions.values()) {
        if (child.id === currentSession.id) continue
        if (child.status !== "idle") continue
        if (typeof child.idleSince !== "number") continue
        entries.push({ id: child.id, idleSince: child.idleSince })
      }
    }

    return entries
  }

  createEffect(
    on(
      () => props.sessionId,
      () => setSubmitBottomPinIntent(null),
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => props.isActive,
      (isActive, wasActive) => {
        if (!isActive) return
        if (wasActive === true) return
        if (!shouldScrollToBottomOnActivate()) return
        scheduleScrollToBottom()
      },
    ),
  )

  createEffect(() => {
    const intent = submitBottomPinIntent()
    const currentSession = session()
    if (!intent || !currentSession) return

    if (sessionStreamingActive() && intent.sessionId === currentSession.id && !intent.observedStreaming) {
      setSubmitBottomPinIntent({ ...intent, observedStreaming: true })
      return
    }

    const messageCount = visibleMessageCount()
    if (shouldClearSessionBottomPinIntent(intent, {
      sessionId: currentSession.id,
      messageCount,
      streamingActive: sessionStreamingActive(),
    })) {
      setSubmitBottomPinIntent(null)
    }
  })

  createEffect(() => {
    const currentSession = session()
    if (!currentSession || !canMarkSessionIdleSeen({
      active: props.isActive === true && documentAttentionActive(),
      visibilityState: document.visibilityState,
      focused: document.hasFocus(),
    })) return

    const seenIdleEntries = getSeenIdleEntries(currentSession, preferences().keepUnseenSubagentIdleStatus)
    for (const entry of seenIdleEntries) {
      const timerKey = `${props.instanceId}:${entry.id}:${entry.idleSince}`
      if (pendingIdleSeenTimers.has(timerKey)) continue
      pendingIdleSeenTimers.add(timerKey)
      markSessionIdleFadeStarted(props.instanceId, entry.id)
      markSessionIdleSeen(props.instanceId, entry.id)

      window.setTimeout(() => {
        pendingIdleSeenTimers.delete(timerKey)
        clearSessionIdleFade(props.instanceId, entry.id, entry.idleSince)
      }, IDLE_STATUS_VISIBILITY_MS)
    }
  })

  createEffect(
    on(
      () => props.isActive,
      (isActive) => {
        if (!isActive) {
          if (props.focusConversationOnActivate) props.onConversationFocusHandled?.()
          clearConversationPlaybackForSession(props.instanceId, props.sessionId)
          return
        }

        // On phones, focusing the prompt on session switch is disruptive (it raises the OSK).
        if (props.isPhoneLayout && !props.focusConversationOnActivate) return

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
            if (!props.isActive) return
            if (props.focusConversationOnActivate) {
              const activeElement = document.activeElement
              const focusIsUnclaimed =
                !activeElement || activeElement === document.body || activeElement === document.documentElement
              const modalIsOpen = Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'))
              if (focusIsUnclaimed && !modalIsOpen && focusConversationStream(rootRef)) {
                props.onConversationFocusHandled?.()
                return
              }
              props.onConversationFocusHandled?.()
              if (!focusIsUnclaimed || modalIsOpen) return
            }
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

  // Drive the active session's initial message load from a value-diffed id so
  // the effect runs once per real session change instead of on every mutation
  // of the reactive sessions map (see the hook for the full rationale).
  useActiveSessionMessageLoad({
    isActive: () => Boolean(props.isActive),
    instanceId: () => props.instanceId,
    session,
    loadMessages,
    waitForHydration: waitForInstanceWorkspaceMetadataHydration,
    onError: (error) => log.error("Failed to load messages", error),
  })

  function handleReloadMessages() {
    const currentSession = session()
    if (!currentSession) return
    loadMessages(props.instanceId, currentSession.id, { force: true }).catch((error) =>
      log.error("Failed to reload messages", error),
    )
  }

  function registerPromptInputApi(api: PromptInputApi) {
    promptInputApi = api
    props.registerSessionPromptApi?.(props.sessionId, api)

    if (pendingPromptText) {
      api.setPromptText(pendingPromptText, { focus: true })
      pendingPromptText = null
    }

    if (pendingSelectionInsert) {
      api.insertSelection(pendingSelectionInsert.text, pendingSelectionInsert.mode)
      pendingSelectionInsert = null
    }

    if (pendingCommentText) {
      api.insertComment(pendingCommentText)
      pendingCommentText = null
    }

    return () => {
      if (promptInputApi === api) {
        promptInputApi = null
        props.registerSessionPromptApi?.(props.sessionId, null)
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

  function handleInsertPreviewComment(markdown: string) {
    if (promptInputApi) {
      promptInputApi.insertComment(markdown)
    } else {
      pendingCommentText = `${pendingCommentText ?? ""}${markdown}`
    }
  }

  async function handleSendMessage(prompt: string, attachments: Attachment[], delivery: PromptDelivery) {
    if (!isLatestMessageWindow(props.instanceId, props.sessionId)) {
      await loadLatestMessageWindow(props.instanceId, props.sessionId)
    }
    const editing = editingQueuedPrompt()
    const effectiveDelivery = editing?.delivery ?? delivery
    const messageCount = visibleMessageCount()
    const submittedExchangeTargetCount = getSubmitBottomPinTargetCount(messageCount, sessionStreamingActive())
    const initialPinIntent = effectiveDelivery === "queue"
      ? undefined
      : forceSubmittedExchangeToBottom(submittedExchangeTargetCount, { createdMessageCount: messageCount })
    try {
      const queueOrder = editing ? queuedPrompts().map((item) => item.id) : []
      const admittedId = await sendMessage(props.instanceId, props.sessionId, prompt, attachments, editing
        ? { delivery: editing.delivery, replace: editing }
        : { delivery })
      if (editing) {
        cancelQueuedPromptEdit()
        try {
          await rewriteQueuedPrompts(queueOrder.map((id) => id === editing.id ? admittedId : id))
        } catch (error) {
          log.error("Failed to restore edited prompt position", error)
          showQueueError(error)
        }
      }
      if (!initialPinIntent) return
      const latestMessageCount = visibleMessageCount()
      if (latestMessageCount < submittedExchangeTargetCount && !sessionStreamingActive()) {
        setSubmitBottomPinIntent(null)
      } else if (submitBottomPinIntent()?.token === initialPinIntent.token) {
        forceSubmittedExchangeToBottom(Math.max(submittedExchangeTargetCount, latestMessageCount), {
          createdMessageCount: messageCount,
          preserveObservedStreaming: true,
        })
      }
    } catch (error) {
      if (initialPinIntent) setSubmitBottomPinIntent(null)
      throw error
    }
  }

  function queuedPromptText(item: SessionInboxUser): string {
    const display = item.payload.metadata?.displayText
    return typeof display === "string" && display ? display : item.payload.text
  }

  function cancelQueuedPromptEdit() {
    if (!editingQueuedPrompt()) return
    const stash = queuedPromptEditStash
    queuedPromptEditStash = null
    setEditingQueuedPrompt(undefined)
    if (!stash) return
    hydrateSessionAttachments(props.instanceId, props.sessionId, stash.attachments)
    promptInputApi?.setPromptText(stash.prompt, { focus: true })
  }

  function handleEditQueuedPrompt(item: SessionInboxUser) {
    if (!promptInputApi) return
    if (editingQueuedPrompt()) cancelQueuedPromptEdit()
    queuedPromptEditStash = { prompt: promptInputApi.getPromptText(), attachments: [...attachments()] }
    setEditingQueuedPrompt(item)
    hydrateSessionAttachments(props.instanceId, props.sessionId, [])
    promptInputApi.setPromptText(queuedPromptText(item), { focus: true })
  }

  function showQueueError(error: unknown) {
    log.error("Prompt queue operation failed", error)
    showAlertDialog(t("promptQueue.error.message"), {
      title: t("promptQueue.error.title"),
      variant: "error",
    })
  }

  async function rewriteQueuedPrompts(inboxIds: string[]) {
    const client = instances().get(props.instanceId)?.client
    if (!client) throw new Error("Instance not ready")
    const pending = await client.session.inbox.list({ sessionID: props.sessionId })
    if (pending.some((item) => item.delivery === "queue" && item.type !== "user")) {
      throw new Error("Queued control items prevent reordering")
    }
    const current = pending.filter((item): item is SessionInboxUser => item.type === "user" && item.delivery === "queue")
    const ordered = inboxIds.flatMap((id) => current.filter((item) => item.id === id))
    if (ordered.length !== current.length) throw new Error("Prompt queue changed before reordering")
    const changed = ordered.findIndex((item, index) => item.id !== current[index]?.id)
    if (changed < 0) return

    for (const item of ordered.slice(changed)) {
      await client.session.prompt({
        sessionID: props.sessionId,
        text: item.payload.text,
        files: item.payload.files?.map((file) => ({
          uri: `data:${file.mime};base64,${file.data}`,
          name: file.name,
          description: file.description,
          mention: file.mention,
        })),
        agents: item.payload.agents,
        skills: item.payload.skills,
        metadata: item.payload.metadata,
        delivery: "queue",
        resume: false,
      })
    }
    for (const item of current.slice(changed)) {
      await client.session.inbox.cancel({ sessionID: props.sessionId, inboxID: item.id })
    }
  }

  async function moveQueuedPrompt(item: SessionInboxUser, direction: -1 | 1) {
    const ids = queuedPrompts().map((entry) => entry.id)
    const index = ids.indexOf(item.id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= ids.length) return
    ;[ids[index], ids[target]] = [ids[target], ids[index]]
    setQueueBusyId(item.id)
    try {
      await rewriteQueuedPrompts(ids)
    } catch (error) {
      showQueueError(error)
    } finally {
      await syncOpenCodeSessionInbox(props.instanceId, props.sessionId, props.instanceFolder).catch(() => undefined)
      setQueueBusyId(undefined)
    }
  }

  async function manageQueuedPrompt(item: SessionInboxUser, action: "delivery" | "remove") {
    setQueueBusyId(item.id)
    try {
      const inbox = instances().get(props.instanceId)?.client?.session.inbox
      if (!inbox) throw new Error("Instance not ready")
      if (action === "remove") {
        await inbox.cancel({ sessionID: props.sessionId, inboxID: item.id })
        if (editingQueuedPrompt()?.id === item.id) cancelQueuedPromptEdit()
      } else if (item.delivery === "queue") {
        await inbox.steer({ sessionID: props.sessionId, inboxID: item.id })
      } else {
        await inbox.queue({ sessionID: props.sessionId, inboxID: item.id })
      }
    } catch (error) {
      showQueueError(error)
    } finally {
      await syncOpenCodeSessionInbox(props.instanceId, props.sessionId, props.instanceFolder).catch(() => undefined)
      setQueueBusyId(undefined)
    }
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
      await instance.client.session.revert.stage({
        sessionID: props.sessionId,
        messageID: messageId,
      })

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

      ensureSessionAncestorsExpanded(props.instanceId, forkedSession.id)
      setActiveSessionFromList(props.instanceId, forkedSession.id)

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
      when={session()?.id}
      fallback={
        <div class="flex items-center justify-center h-full">
          <div class="text-center text-gray-500">{t("sessionView.fallback.sessionNotFound")}</div>
        </div>
      }
    >
      <div ref={rootRef} class="session-view">
        <Show
          when={preview()?.mode === "preview"}
          fallback={
            <MessageSection
              instanceId={props.instanceId}
              sessionId={props.sessionId}
              loading={messagesLoading()}
              loadError={messagesLoadError()}
              onReloadMessages={handleReloadMessages}
              hasMoreMessages={hasMoreMessages(props.instanceId, props.sessionId)}
              getMessageHistoryCursor={() => getMessageNextCursor(props.instanceId, props.sessionId)}
              onLoadMoreMessages={() => loadMoreMessages(props.instanceId, props.sessionId)}
              onLoadNewerMessages={() => loadNewerMessageWindow(props.instanceId, props.sessionId)}
              onLoadLatestMessages={() => loadLatestMessageWindow(props.instanceId, props.sessionId)}
              onLoadOldestMessages={() => loadOldestMessageWindow(props.instanceId, props.sessionId)}
              sessionStreamingActive={sessionStreamingActive()}
              explicitBottomPinIntent={activeSubmitBottomPinIntent()}
              onExplicitBottomPinCancelled={() => setSubmitBottomPinIntent(null)}
              onRevert={handleRevert}
              onFork={handleFork}
              isActive={props.isActive}
              registerScrollToBottom={(fn) => {
                scrollToBottomHandle = fn ?? undefined
              }}
              showSidebarToggle={props.showSidebarToggle}
              onSidebarToggle={props.onSidebarToggle}
              forceCompactStatusLayout={props.forceCompactStatusLayout}
              queuedMessageIds={queuedMessageIds()}
              onQuoteSelection={handleQuoteSelection}
            />
          }
        >
          <SessionPreviewView
            preview={preview()!}
            onBackToChat={() => showSessionChat(props.sessionId)}
            onClose={() => void closeSessionPreview(props.sessionId)}
            onInsertComment={handleInsertPreviewComment}
          />
        </Show>

        <PromptQueue
          items={queuedPrompts()}
          busyId={queueBusyId()}
          editingId={editingQueuedPrompt()?.id}
          onDeliveryChange={(item) => void manageQueuedPrompt(item, "delivery")}
          onEdit={handleEditQueuedPrompt}
          onCancelEdit={cancelQueuedPromptEdit}
          onRemove={(item) => void manageQueuedPrompt(item, "remove")}
          onMove={(item, direction) => void moveQueuedPrompt(item, direction)}
        />

        <Show when={attachments().length > 0}>
          <PromptAttachmentsBar
            attachments={attachments()}
            onRemoveAttachment={(attachmentId) => {
              if (promptInputApi) {
                promptInputApi.removeAttachment(attachmentId)
                return
              }
              removeAttachment(props.instanceId, props.sessionId, attachmentId)
            }}
            onExpandTextAttachment={(attachmentId) => promptInputApi?.expandTextAttachment(attachmentId)}
          />
        </Show>

        <PromptInput
          instanceId={props.instanceId}
          instanceFolder={props.instanceFolder}
          sessionId={props.sessionId}
          isActive={props.isActive}
          compactLayout={props.compactPromptLayout}
          onSend={handleSendMessage}
          onRunShell={handleRunShell}
          escapeInDebounce={props.escapeInDebounce}
          isSessionBusy={sessionBusy()}
          disabled={sessionNeedsInput()}
          onAbortSession={handleAbortSession}
          registerPromptInputApi={registerPromptInputApi}
        />
      </div>
    </Show>
  )
}

export default SessionView
