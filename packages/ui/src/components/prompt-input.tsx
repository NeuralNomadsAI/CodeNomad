import { Suspense, createEffect, createMemo, createSignal, createUniqueId, lazy, on, onCleanup, Show } from "solid-js"
import { ArrowDown, ArrowUp, CheckSquare, ListEnd, Loader2, Paperclip, SendHorizontal, Square, X } from "lucide-solid"
import { addAttachment, clearAttachments, removeAttachment } from "../stores/attachments"
import { createPastedPlaceholderRegex, pastedDisplayCounterRegex } from "./prompt-input/attachmentPlaceholders"
import { preparePromptSubmission, resolvePromptDelivery } from "./prompt-input/submitPrompt"
import { findConversationStream, focusConversationStream } from "./focus-conversation"
import { shouldTypeIntoComposer } from "./prompt-input/type-to-focus"
import { hotkeyLabel, withHotkey } from "../lib/hotkeys"
import { keyboardRegistry } from "../lib/keyboard-registry"
import { PROMPT_CLEAR_EVENT } from "../lib/session-sidebar-events"
import { getActiveInstance, instances } from "../stores/instances"
import { agents, executeCustomCommand, sessions } from "../stores/sessions"
import { getCommands } from "../stores/commands"
import { showAlertDialog } from "../stores/alerts"
import { useI18n } from "../lib/i18n"
import { captureBackendOperation } from "../lib/backend-operation"
import { getLogger } from "../lib/logger"
import { getOpencodeErrorMessage } from "../lib/opencode-api"
import { createAttachmentPlaceholderRegex, getAttachmentPlaceholder } from "../lib/attachment-placeholders"
import { preferences } from "../stores/preferences"
import { openSettingsRow } from "../stores/settings-screen"
import { microphoneUse, refreshMicrophoneUse } from "../lib/microphone-lease"
import { useLiveVoiceConversation } from "../lib/hooks/use-live-voice-conversation"
import LiveVoiceConversationWindow, { LIVE_VOICE_CONVERSATION_WINDOW_ID } from "./live-voice-conversation-window"
import DictationNotice from "./prompt-input/DictationNotice"
import DictationButton from "./prompt-input/DictationButton"
import { sessionPromptAwaitingExecution } from "../stores/session-prompt-ack"
import type { PromptInputApi, PromptInputProps, PromptInsertMode, PromptMode } from "./prompt-input/types"
import type { Attachment } from "../types/attachment"
import { usePromptState } from "./prompt-input/usePromptState"
import { backendScoped, parseInstanceKey } from "../lib/backend-identity"
import { usePromptAttachments } from "./prompt-input/usePromptAttachments"
import { usePromptPicker } from "./prompt-input/usePromptPicker"
import { usePromptKeyDown } from "./prompt-input/usePromptKeyDown"
import { usePromptVoiceInput } from "./prompt-input/usePromptVoiceInput"
import { usePromptAside } from "./prompt-input/usePromptAside"
import { capPromptHeight, usePromptViewport } from "./prompt-input/usePromptViewport"
import PromptAsideWindow from "./prompt-input/PromptAsideWindow"
import {
  MIN_PROMPT_FIELD_HEIGHT_RATIO,
  MAX_PROMPT_FIELD_HEIGHT_RATIO,
  initializePromptInputHeight,
  persistPromptInputHeight,
  promptInputHeight,
  setPromptInputHeight,
} from "./prompt-input/height-state"
import {
  classicConversationUnavailable,
  clearConversationPlaybackForInstance,
  isConversationModeEnabled,
  toggleConversationMode,
} from "../stores/conversation-speech"
import { loadVoiceConversationEngine, voiceConversationEngine, voiceConversationEngineLoaded } from "../stores/voice-conversation-engine"
import ActionOverflowMenu, { type ActionOverflowMenuItem } from "./action-overflow-menu"
import { requestUserMessageJump } from "./user-message-navigation"
const log = getLogger("actions")
const LazyUnifiedPicker = lazy(() => import("./unified-picker"))
const DEFAULT_PROMPT_FIELD_HEIGHT = 104
const MIN_PROMPT_FIELD_HEIGHT = 44

type ResizeDragState = {
  pointerId: number
  startY: number
  startHeight: number
  maxHeight: number
  changed: boolean
}

function getConsumedPastedTextAttachmentIds(text: string, attachments: Attachment[]): string[] {
  if (!text || attachments.length === 0) return []

  const usedCounters = new Set<string>()
  for (const match of text.matchAll(createPastedPlaceholderRegex())) {
    const counter = match?.[1]
    if (counter) usedCounters.add(counter)
  }

  if (usedCounters.size === 0) return []

  const consumed = new Set<string>()

  for (const attachment of attachments) {
    if (!attachment?.id) continue
    if (attachment?.source?.type !== "text") continue
    const display = attachment.display
    if (typeof display !== "string") continue
    const match = display.match(pastedDisplayCounterRegex)
    if (!match?.[1]) continue
    if (usedCounters.has(match[1])) {
      consumed.add(attachment.id)
    }
  }

  return Array.from(consumed)
}

export default function PromptInput(props: PromptInputProps) {
  const { t } = useI18n()
  const asideId = createUniqueId()
  const helpId = createUniqueId()
  const aside = usePromptAside({
    instanceId: () => props.instanceId,
    sessionId: () => props.sessionId,
    active: () => props.isActive !== false,
  })
  // Local utility commands never reach native prompt/command submission.
  const promptCommands = () => [
    { name: "btw", description: t("promptInput.btw.commandDescription") },
    ...getCommands(props.instanceId).filter(command => command.name !== "btw"),
  ]
  initializePromptInputHeight(props.instanceId)
  createEffect(on(() => props.instanceId, (instanceId) => initializePromptInputHeight(instanceId), { defer: true }))
  const [, setIsFocused] = createSignal(false)
  const [mode, setMode] = createSignal<PromptMode>("normal")
  const inputHeight = () => promptInputHeight(props.instanceId)
  const setInputHeight = (value: Parameters<typeof setPromptInputHeight>[1]) => setPromptInputHeight(props.instanceId, value)
  const persistInputHeight = (...value: [] | [Parameters<typeof persistPromptInputHeight>[1]]) =>
    persistPromptInputHeight(props.instanceId, ...value)
  const [isResizing, setIsResizing] = createSignal(false)
  const SELECTION_INSERT_MAX_LENGTH = 2000
  let textareaRef: HTMLTextAreaElement | undefined
  let wrapperRef: HTMLDivElement | undefined
  const viewport = usePromptViewport(() => wrapperRef, () => Boolean(props.interruptionExpanded))
  let resizeDragState: ResizeDragState | undefined
  const [submissionsInFlight, setSubmissionsInFlight] = createSignal(0)
  let restoredQueuedPayload: Parameters<PromptInputApi["restoreQueuedPrompt"]>[1] | undefined

  const getPlaceholder = () => {
    if (mode() === "shell") {
      return t("promptInput.placeholder.shell")
    }
    return t("promptInput.placeholder.default")
  }

  const minimumForViewport = (height: number) => height > 0
    ? Math.max(MIN_PROMPT_FIELD_HEIGHT, Math.floor(height * MIN_PROMPT_FIELD_HEIGHT_RATIO))
    : DEFAULT_PROMPT_FIELD_HEIGHT
  const defaultFieldHeight = () => minimumForViewport(viewport().referenceHeight)
  const compactLayoutEnabled = () => Math.min(defaultFieldHeight(), effectiveInputHeight()) < DEFAULT_PROMPT_FIELD_HEIGHT
  const minimumFieldHeight = defaultFieldHeight
  const heightPreference = (height: number) => ({
    ratio: height <= minimumFieldHeight() ? MIN_PROMPT_FIELD_HEIGHT_RATIO
      : height >= computeMaxFieldHeight() ? MAX_PROMPT_FIELD_HEIGHT_RATIO
      : height / (viewport().referenceHeight || window.innerHeight),
  })
  createEffect(() => {
    const saved = inputHeight()
    if (!props.interruptionExpanded && typeof saved === "number" && viewport().referenceHeight > 0) {
      persistInputHeight(heightPreference(saved))
    }
  })
  const desiredFieldHeight = () => {
    const saved = inputHeight()
    const desired = saved === null ? defaultFieldHeight()
      : typeof saved === "number" ? saved
      : saved.ratio === MIN_PROMPT_FIELD_HEIGHT_RATIO ? minimumFieldHeight()
      : Math.round(viewport().referenceHeight * saved.ratio)
    return Math.min(computeMaxFieldHeight(), Math.max(minimumFieldHeight(), desired))
  }
  const effectiveInputHeight = () => props.interruptionExpanded
    ? minimumForViewport(viewport().visibleHeight)
    : capPromptHeight(desiredFieldHeight(), viewport().fieldSpace, MIN_PROMPT_FIELD_HEIGHT)

  const fieldHeightStyle = () => {
    const height = effectiveInputHeight()
    if (inputHeight() !== null) return { height: `${height}px`, "min-height": `${height}px` }
    return { height: `${height}px` }
  }

  const promptState = usePromptState({
    instanceId: () => props.instanceId,
    sessionId: () => props.sessionId,
    instanceFolder: () => props.instanceFolder,
    historyKey: () => backendScoped(parseInstanceKey(props.instanceId).backendId, props.instanceFolder),
  })

  const {
    prompt,
    setPrompt,
    clearPrompt,
    draftLoadedNonce,
    history,
    historyIndex,
    recordHistoryEntry,
    clearHistoryDraft,
    resetHistoryNavigation,
    selectPreviousHistory,
    selectNextHistory,
  } = promptState

  createEffect(() => {
    if (!prompt()) restoredQueuedPayload = undefined
  })

  const {
    attachments,
    isDragging,
    isReadingFiles,
    handlePaste,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleUploadFiles,
    syncAttachmentCounters,
    handleExpandTextAttachment,
    handleRemoveAttachment,
  } = usePromptAttachments({
    instanceId: () => props.instanceId,
    sessionId: () => props.sessionId,
    instanceFolder: () => props.instanceFolder,
    prompt,
    setPrompt,
    getTextarea: () => textareaRef ?? null,
    disabled: () => Boolean(props.disabled),
    active: () => props.isActive !== false,
  })

  createEffect(() => {
    if (!props.registerPromptInputApi) return
    const api: PromptInputApi = {
      insertSelection: (text: string, mode: PromptInsertMode) => {
        if (mode === "code") {
          insertCodeSelection(text)
        } else {
          insertQuotedSelection(text)
        }
      },
      insertComment: (text: string) => {
        const normalized = (text ?? "").replace(/\r/g, "").trim()
        if (!normalized) return
        insertBlockContent(`${normalized}\n\n`)
      },
      expandTextAttachment: (attachmentId: string) => {
        const attachment = attachments().find((a) => a.id === attachmentId)
        if (!attachment) return
        handleExpandTextAttachment(attachment)
      },
      removeAttachment: (attachmentId: string) => {
        handleRemoveAttachment(attachmentId)
      },
      setPromptText: (text: string, opts?: { focus?: boolean }) => {
        restoredQueuedPayload = undefined
        const textarea = textareaRef
        if (textarea) {
          textarea.value = text
          textarea.dispatchEvent(new Event("input", { bubbles: true }))
          if (opts?.focus) {
            try {
              textarea.focus({ preventScroll: true } as any)
            } catch {
              textarea.focus()
            }
          }
          return
        }

        setPrompt(text)
        if (opts?.focus) {
          setTimeout(() => {
            api.focus()
          }, 0)
        }
      },
      restoreQueuedPrompt: (text, payload) => {
        api.setPromptText(text, { focus: true })
        restoredQueuedPayload = payload
      },
      getPromptText: prompt,
      getMode: mode,
      focus: () => {
        const textarea = textareaRef
        if (!textarea || textarea.disabled) return
        try {
          textarea.focus({ preventScroll: true } as any)
        } catch {
          textarea.focus()
        }
      },
    }
    const cleanup = props.registerPromptInputApi(api)
    onCleanup(() => {
      if (typeof cleanup === "function") {
        cleanup()
      }
    })
  })

  const instanceAgents = () => agents().get(props.instanceId) || []

  const promptPicker = usePromptPicker({
    instanceId: () => props.instanceId,
    sessionId: () => props.sessionId,
    instanceFolder: () => props.instanceFolder,
    prompt,
    setPrompt,
    getTextarea: () => textareaRef ?? null,
    instanceAgents,
    commands: promptCommands,
  })

  const {
    showPicker,
    pickerMode,
    searchQuery,
    ignoredAtPositions,
    setShowPicker,
    setPickerMode,
    setSearchQuery,
    setAtPosition,
    setIgnoredAtPositions,
    handleInput,
    handlePickerSelect,
    handlePickerClose,
  } = promptPicker

  createEffect(
    on(
      draftLoadedNonce,
      () => {
        // Session switch resets (picker/counters/ignored positions) stay in the component.
        setIgnoredAtPositions(new Set<number>())
        setShowPicker(false)
        setPickerMode("mention")
        setAtPosition(null)
        setSearchQuery("")

        syncAttachmentCounters(prompt())
      },
      { defer: true },
    ),
  )

  const isTouchOnlyPointer = () => {
    if (typeof window === "undefined") return false
    return Boolean(window.matchMedia?.("(pointer: coarse)")?.matches && !window.matchMedia?.("(any-pointer: fine)")?.matches)
  }

  createEffect(() => {
    // Scope global "type-to-focus" behavior to the active, visible prompt only.
    if (typeof document === "undefined") return
    if (isTouchOnlyPointer()) return
    if (props.isActive === false) return
    if (props.disabled) return

    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const conversation = findConversationStream(wrapperRef?.closest(".session-view"))
      if (!shouldTypeIntoComposer(e, document.activeElement, conversation)) return
      // A shortcut bound to a plain key keeps it rather than becoming draft text.
      if (keyboardRegistry.findMatch(e)) return

      const textarea = textareaRef
      if (!textarea || textarea.disabled) return

      // In session cache mode inactive panes are display:none; avoid stealing focus.
      if (textarea.offsetParent === null) return

      if (e.key === "!" && prompt().length === 0) {
        e.preventDefault()
        setMode("shell")
        textarea.focus()
        return
      }

      // Focus moves during keydown, so the browser inserts this character.
      textarea.focus()
    }

    document.addEventListener("keydown", handleGlobalKeyDown)
    onCleanup(() => {
      document.removeEventListener("keydown", handleGlobalKeyDown)
    })
  })

  function computeMaxFieldHeight(): number {
    if (typeof window === "undefined") return DEFAULT_PROMPT_FIELD_HEIGHT

    const availableHeight = viewport().referenceHeight || window.innerHeight
    const maxHeight = Math.floor(availableHeight * MAX_PROMPT_FIELD_HEIGHT_RATIO)
    return Math.max(defaultFieldHeight(), maxHeight)
  }

  function handleResizeStart(event: PointerEvent) {
    event.preventDefault()
    if (props.interruptionExpanded) return
    const target = event.currentTarget as HTMLElement

    resizeDragState = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: desiredFieldHeight(),
      maxHeight: computeMaxFieldHeight(),
      changed: false,
    }

    setIsResizing(true)

    try {
      target.setPointerCapture(event.pointerId)
    } catch {
      resizeDragState = undefined
      setIsResizing(false)
    }
  }

  function handleResizeMove(event: PointerEvent) {
    if (props.interruptionExpanded) return
    if (!resizeDragState || resizeDragState.pointerId !== event.pointerId) return

    event.preventDefault()
    const deltaY = resizeDragState.startY - event.clientY
    const nextHeight = Math.max(
      minimumFieldHeight(),
      Math.min(resizeDragState.maxHeight, resizeDragState.startHeight + deltaY),
    )
    if (deltaY !== 0 || resizeDragState.changed) {
      resizeDragState.changed = true
      setInputHeight(heightPreference(nextHeight))
    }
  }

  function handleResizeEnd(event: PointerEvent) {
    if (!resizeDragState || resizeDragState.pointerId !== event.pointerId) return

    event.preventDefault()
    const { changed } = resizeDragState
    resizeDragState = undefined
    setIsResizing(false)
    if (changed) persistInputHeight()
    textareaRef?.focus()
  }

  function handleResizeKeyDown(event: KeyboardEvent) {
    if (props.interruptionExpanded) {
      if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) event.preventDefault()
      return
    }
    const minimum = minimumFieldHeight()
    const current = desiredFieldHeight()
    const max = computeMaxFieldHeight()
    const next = event.key === "ArrowUp"
      ? Math.min(max, current + 16)
      : event.key === "ArrowDown"
        ? Math.max(minimum, current - 16)
        : event.key === "Home"
          ? minimum
          : event.key === "End"
            ? max
            : null
    if (next === null) return
    event.preventDefault()
    persistInputHeight(heightPreference(next))
  }

  onCleanup(() => {
    resizeDragState = undefined
  })
  createEffect(() => {
    if (!props.interruptionExpanded) return
    resizeDragState = undefined
    setIsResizing(false)
  })

  const promptDelivery = (alternate = false) => resolvePromptDelivery(
    Boolean(props.isSessionBusy || submissionsInFlight() > 0 || sessionPromptAwaitingExecution(props.instanceId, props.sessionId)),
    preferences().followUpBehavior,
    alternate,
  )

  async function handleSend(alternate = false) {
    const operation = captureBackendOperation(props.instanceId)
    if (!operation.current()) return
    const draftText = prompt()
    const text = draftText.trim()
    const currentAttachments = attachments()
    if (props.disabled || props.sendBlocked || isReadingFiles() || submissionsInFlight() > 0 || (!text && currentAttachments.length === 0)) return
    const { instanceId, sessionId } = props
    const followUp = preferences().followUpBehavior
    const admitDelivery = () => resolvePromptDelivery(
      Boolean(props.isSessionBusy || sessionPromptAwaitingExecution(instanceId, sessionId)), followUp, alternate,
    )
    const resolvedDelivery = admitDelivery()
    const restoredPayload = restoredQueuedPayload

    const isShellMode = mode() === "shell"
    const retainedImageTokens = () => currentAttachments.flatMap(attachment => {
      if (attachment.source.type !== "file") return []
      const placeholder = getAttachmentPlaceholder(attachment.display)
      return placeholder?.kind === "image"
        ? draftText.match(createAttachmentPlaceholderRegex("image", placeholder.counter)) ?? [] : []
    })

    const asideMatch = !isShellMode && /^\/btw(?:\s+([\s\S]*))?$/.exec(text)
    if (asideMatch) {
      const question = preparePromptSubmission({ mode: "slash", text, attachments: currentAttachments,
        commandToken: "/btw", commandArgs: asideMatch[1] ?? "" }).resolvedCommandArgs
      if (aside.launch(question)) {
        // Pasted text is consumed by the side question; image/file attachments
        // are not sent. Retain image tokens so normal attachment cleanup keeps them.
        const imageTokens = retainedImageTokens()
        if (imageTokens.length) setPrompt(imageTokens.join(" "))
        else clearPrompt()
        clearHistoryDraft()
        setShowPicker(false)
        restoredQueuedPayload = undefined
      }
      return
    }

    // Slash command routing (match OpenCode TUI): only run if the command exists.
    const isSlashCandidate = !isShellMode && text.startsWith("/")
    const firstSpace = isSlashCandidate ? text.indexOf(" ") : -1
    const commandToken = isSlashCandidate ? (firstSpace === -1 ? text : text.slice(0, firstSpace)) : ""
    const commandName = isSlashCandidate ? commandToken.slice(1) : ""
    const commandArgs = isSlashCandidate ? (firstSpace === -1 ? "" : text.slice(firstSpace + 1).trimStart()) : ""

    const isKnownSlashCommand =
      isSlashCandidate &&
      commandName.length > 0 &&
      getCommands(props.instanceId).some((cmd) => cmd.name === commandName)

    const submission = preparePromptSubmission({
      mode: isKnownSlashCommand ? "slash" : isShellMode ? "shell" : "message",
      text,
      attachments: currentAttachments,
      commandToken,
      commandArgs,
    })
    const resolvedCommandArgs = submission.resolvedCommandArgs
    const submitPrompt = submission.submitPrompt
    const historyEntry = submission.historyEntry

    const refreshHistory = () => recordHistoryEntry(historyEntry)
    const previousInputHeight = inputHeight()

    persistInputHeight(null)
    if (isKnownSlashCommand && retainedImageTokens().length) setPrompt(retainedImageTokens().join(" "))
    else clearPrompt()
    clearHistoryDraft()
    setMode("normal")

    // Ignore attachments for slash commands, but keep them for next prompt.
    if (!isKnownSlashCommand) {
      clearAttachments(props.instanceId, props.sessionId)
      syncAttachmentCounters("")
      setIgnoredAtPositions(new Set<number>())
    } else {
      const consumedIds = getConsumedPastedTextAttachmentIds(commandArgs, currentAttachments)
      for (const attachmentId of consumedIds) {
        removeAttachment(props.instanceId, props.sessionId, attachmentId)
      }
      syncAttachmentCounters("")
      setIgnoredAtPositions(new Set<number>())
    }

    clearHistoryDraft()

    // Keep attempted prompts recoverable even when execution fails.
    const retainedDraft = prompt()
    void refreshHistory()

    if (!isTouchOnlyPointer()) {
      focusConversationStream(wrapperRef?.closest(".session-view"))
    }

    setSubmissionsInFlight(count => count + 1)
    try {
      if (isShellMode) {
        if (props.onRunShell) {
          await props.onRunShell(submitPrompt)
        } else {
          await props.onSend(submitPrompt, [], "steer")
        }
      } else if (isKnownSlashCommand) {
        if (props.onCommand) {
          await props.onCommand(commandName, resolvedCommandArgs)
        } else {
          await executeCustomCommand(props.instanceId, props.sessionId, commandName, resolvedCommandArgs)
        }
      } else {
        await props.onSend(submitPrompt, currentAttachments, resolvedDelivery, restoredPayload, admitDelivery)
      }
      if (!operation.current()) throw new DOMException("Backend detached", "AbortError")
      restoredQueuedPayload = undefined
    } catch (error) {
      log.error("Failed to send message:", error)
      if (inputHeight() === null) persistInputHeight(previousInputHeight)
      if (prompt() === retainedDraft) {
        setPrompt(draftText)
        restoredQueuedPayload = restoredPayload
        const existingIds = new Set(attachments().map(attachment => attachment.id))
        for (const attachment of currentAttachments) {
          if (!existingIds.has(attachment.id)) addAttachment(props.instanceId, props.sessionId, attachment)
        }
      }
      if (!operation.current()) return
      showAlertDialog(t("promptInput.send.errorFallback"), {
        title: t("promptInput.send.errorTitle"),
        detail: getOpencodeErrorMessage(error, t("promptInput.send.errorFallback")),
        variant: "error",
      })
      if (!isTouchOnlyPointer()) {
        textareaRef?.focus()
      }
      return
    } finally {
      setSubmissionsInFlight(count => count - 1)
    }
  }

  function handleAbort() {
    if (!props.onAbortSession || !props.isSessionBusy) return
    void props.onAbortSession()
  }

  const canBackground = () => Boolean(props.isSessionBusy && props.onBackgroundSession)

  function handleBackground() {
    if (!canBackground()) return false
    void props.onBackgroundSession?.()
    return true
  }

  function handleResizeMaximize(event: MouseEvent) {
    event.preventDefault()
    if (props.interruptionExpanded) return
    persistInputHeight(heightPreference(computeMaxFieldHeight()))
    textareaRef?.focus()
  }

  function clearTextareaWithUndo() {
    const textarea = textareaRef
    if (!textarea || textarea.disabled) return false

    textarea.focus()
    textarea.setSelectionRange(0, textarea.value.length)

    let cleared = false
    try {
      cleared = typeof document !== "undefined" && typeof document.execCommand === "function" && document.execCommand("delete")
    } catch {
      cleared = false
    }
    if (!cleared || textarea.value.length > 0) {
      textarea.value = ""
    }

    textarea.dispatchEvent(new Event("input", { bubbles: true }))
    return cleared
  }

  function handleClearPrompt() {
    resetHistoryNavigation()
    if (!clearTextareaWithUndo()) {
      clearPrompt()
    }
    clearHistoryDraft()
    setShowPicker(false)
    setPickerMode("mention")
    setAtPosition(null)
    setSearchQuery("")
    setIgnoredAtPositions(new Set<number>())
    syncAttachmentCounters("")
    textareaRef?.focus()
  }

  function insertBlockContent(block: string) {
    const textarea = textareaRef
    const current = prompt()
    const start = textarea ? textarea.selectionStart : current.length
    const end = textarea ? textarea.selectionEnd : current.length
    const before = current.substring(0, start)
    const after = current.substring(end)
    const needsLeading = before.length > 0 && !before.endsWith("\n") ? "\n" : ""
    const insertion = `${needsLeading}${block}`
    const nextValue = before + insertion + after

    setPrompt(nextValue)
    setShowPicker(false)
    setAtPosition(null)

    if (textarea) {
      setTimeout(() => {
        const cursor = before.length + insertion.length
        textarea.focus()
        textarea.setSelectionRange(cursor, cursor)
      }, 0)
    }
  }

  function insertQuotedSelection(rawText: string) {
    const normalized = (rawText ?? "").replace(/\r/g, "").trim()
    if (!normalized) return
    const limited =
      normalized.length > SELECTION_INSERT_MAX_LENGTH
        ? normalized.slice(0, SELECTION_INSERT_MAX_LENGTH).trimEnd()
        : normalized
    const lines = limited
      .split(/\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    if (lines.length === 0) return

    const blockquote = lines.map((line) => `> ${line}`).join("\n")
    if (!blockquote) return

    // End the blockquote with a blank line so the user's next line
    // doesn't get parsed as a lazy continuation of the quote.
    insertBlockContent(`${blockquote}\n\n`)
  }

  function insertCodeSelection(rawText: string) {
    const normalized = (rawText ?? "").replace(/\r/g, "")
    const limited =
      normalized.length > SELECTION_INSERT_MAX_LENGTH
        ? normalized.slice(0, SELECTION_INSERT_MAX_LENGTH)
        : normalized
    const trimmed = limited.replace(/^\n+/, "").replace(/\n+$/, "")
    if (!trimmed) return

    const block = "```\n" + trimmed + "\n```\n\n"
    insertBlockContent(block)
  }

  const canStop = () => Boolean(props.isSessionBusy && props.onAbortSession)

  const hasHistory = () => history().length > 0
  const canHistoryGoPrevious = () => hasHistory() && (historyIndex() === -1 || historyIndex() < history().length - 1)
  const canHistoryGoNext = () => historyIndex() >= 0

  const canSend = () => {
    if (props.disabled || props.sendBlocked || isReadingFiles()) return false
    const hasText = prompt().trim().length > 0
    if (mode() === "shell") return hasText
    return hasText || attachments().length > 0
  }

  // Boolean memos, so the action menu rebuilds only when they flip, not per keystroke.
  const canClearPrompt = createMemo(() => prompt().length > 0)
  const canSendDraft = createMemo(() => canSend())
  const canNavigateUserMessages = createMemo(() => props.isActive !== false && props.sessionId !== "info" && Boolean(sessions().get(props.instanceId)?.has(props.sessionId)))

  const submitOnEnter = () => preferences().promptSubmitOnEnter

  const handleKeyDown = usePromptKeyDown({
    getTextarea: () => textareaRef ?? null,
    prompt,
    setPrompt,
    mode,
    setMode,
    isPickerOpen: showPicker,
    closePicker: handlePickerClose,
    ignoredAtPositions,
    setIgnoredAtPositions,
    getAttachments: attachments,
    removeAttachment: (attachmentId) => removeAttachment(props.instanceId, props.sessionId, attachmentId),
    submitOnEnter,
    onSend: (alternate) => void handleSend(Boolean(alternate)),
    onBackground: handleBackground,
    selectPreviousHistory: (force) =>
      selectPreviousHistory({ force, isPickerOpen: showPicker(), getTextarea: () => textareaRef ?? null }),
    selectNextHistory: (force) =>
      selectNextHistory({ force, isPickerOpen: showPicker(), getTextarea: () => textareaRef ?? null }),
  })

  const shouldShowAbortReminder = () => Boolean(props.escapeInDebounce && hotkeyLabel("session-abort"))
  const shouldShowOverlay = () => shouldShowAbortReminder()
    || (prompt().length === 0 && (attachments().length > 0 || mode() === "shell"))
  const canInsertTranscript = () => mode() === "normal" && !props.disabled
  const voiceInput = usePromptVoiceInput({
    prompt,
    draftRevision: promptState.draftRevision,
    setPrompt,
    getTextarea: () => textareaRef ?? null,
    instanceId: () => props.instanceId,
    sessionId: () => props.sessionId,
    directory: () => props.instanceFolder,
    captureOwner: () => {
      const id = props.instanceId
      const operation = captureBackendOperation(id)
      const source = instances().get(id)
      const folder = source?.folder
      const proxyPath = source?.proxyPath
      return () => {
        const current = instances().get(id)
        return operation.current() && Boolean(source && current && folder === current.folder && proxyPath === current.proxyPath)
      }
    },
    active: () => props.isActive !== false,
    enabled: () => props.isActive !== false && preferences().showPromptVoiceInput,
    disabled: () => Boolean(props.disabled) || props.isActive === false || mode() !== "normal",
    sending: () => submissionsInFlight() > 0,
    canInsertTranscript,
  })
  const liveVoice = useLiveVoiceConversation({
    instanceId: () => props.instanceId,
    sessionId: () => props.sessionId,
    active: () => props.isActive !== false,
    followUp: () => preferences().followUpBehavior,
    canSend: () => !props.disabled && !props.sendBlocked,
  })
  const liveVoiceTargetLabel = () => sessions().get(props.instanceId)?.get(props.sessionId)?.title || t("voice.command.activeSession")
  const conversationIsLiveEngine = () => liveVoice.state().phase !== "closed" ||
    (voiceConversationEngineLoaded() && voiceConversationEngine() !== "classic")
  const conversationModeEnabled = () => isConversationModeEnabled(props.instanceId)
  createEffect(() => {
    if (props.isActive !== false) void loadVoiceConversationEngine().catch(() => {})
  })
  createEffect(() => {
    if (props.isActive !== false && conversationModeEnabled()
      && voiceConversationEngineLoaded() && voiceConversationEngine() !== "classic") toggleConversationMode(props.instanceId)
  })
  const liveVoiceRunning = () => liveVoice.state().phase === "consent" ||
    liveVoice.state().phase === "starting" || liveVoice.state().phase === "live"
  const conversationRunning = () => conversationIsLiveEngine() ? liveVoiceRunning() : conversationModeEnabled()
  const [dictationSelected, setDictationSelected] = createSignal(false)
  const dictationMode = () => dictationSelected() && preferences().showPromptVoiceInput && !conversationRunning()
  createEffect(() => {
    if (!dictationMode()) voiceInput.cancelRecording()
  })
  const voiceMenuLabel = (label: string, reason: string | undefined) => reason
    ? t("voice.command.unavailable", { action: label, reason })
    : label
  const conversationReason = () => {
    if (!conversationIsLiveEngine()) {
      const reason = classicConversationUnavailable()
      if (reason) return { text: t(`voice.command.${reason}`),
        row: reason === "loading" || reason === "capabilitiesError" ? "voice-conversation" : "voice-playback" } as const
      return
    }
    const unavailable = liveVoice.unavailable()
    if (unavailable === "missingKey") return { text: t(voiceConversationEngine() === "gemini-live"
      ? "voice.command.setupGemini" : "voice.command.setupOpenAI"), row: "voice-conversation" } as const
    if (unavailable === "composerUnavailable") return { text: t("voice.command.composerUnavailable") } as const
    if (unavailable) return { text: t(`voice.command.${unavailable}`), row: "voice-conversation" } as const
    const purpose = microphoneUse()
    return purpose ? { text: t(`voice.microphone.${purpose}`), row: "voice-conversation" } as const : undefined
  }

  const instance = () => getActiveInstance()

  const beginVoiceInput = () => {
    if (!voiceInput.canStartRecording()) return
    clearConversationPlaybackForInstance(props.instanceId)
    void voiceInput.startRecording()
  }

  const buildPromptActionMenuItems = (): ActionOverflowMenuItem[] => {
    const items: ActionOverflowMenuItem[] = []
    // The other follow-up delivery than Enter's, like the alternate-send shortcut:
    // queue when Enter steers, send now when Enter queues. Only a running session differs.
    const alternate = preferences().followUpBehavior === "queue" ? "steer" : "queue"
    items.push({
      key: "alternate-send",
      label: t(alternate === "queue" ? "promptInput.send.queueAriaLabel" : "promptQueue.actions.steer"),
      description: hotkeyLabel("prompt-alternate-send") || undefined,
      icon: alternate === "queue"
        ? <ListEnd class="h-4 w-4" aria-hidden="true" />
        : <SendHorizontal class="h-4 w-4" aria-hidden="true" />,
      disabled: mode() !== "normal" || !(props.isSessionBusy || sessionPromptAwaitingExecution(props.instanceId, props.sessionId)) || !canSendDraft(),
      // The shortcut's own resolution: an idle session always sends normally.
      onSelect: () => void handleSend(true),
    })
    const dictationReason = conversationRunning() || voiceInput.state() !== "idle" ? undefined : voiceInput.unavailableKey()
    items.push({
      key: "voice",
      label: voiceMenuLabel(t("voice.command.dictation"), dictationReason && t(dictationReason)),
      icon: dictationMode() ? <CheckSquare class="h-4 w-4" aria-hidden="true" /> : <Square class="h-4 w-4" aria-hidden="true" />,
      checked: dictationMode(),
      disabled: conversationRunning() || (!dictationMode() && dictationReason === "voice.command.pendingTranscription"),
      onSelect: dictationReason && !dictationMode() ? () => openSettingsRow("speech", "voice-dictation")
        : () => { setDictationSelected(!dictationMode()) },
    })
    if (voiceInput.state() !== "idle" && voiceInput.state() !== "limitReached") {
      items.push({
        key: "voice-cancel",
        label: t("promptInput.voiceInput.cancel"),
        icon: <X class="h-4 w-4" aria-hidden="true" />,
        selectBeforeClose: true,
        onSelect: voiceInput.cancelRecording,
      })
    }
    const liveEngine = conversationIsLiveEngine()
    const running = conversationRunning()
    const retained = liveVoice.state().phase === "ended"
    const reason = running || retained || dictationMode() ? undefined : conversationReason()
    const focusLiveWindow = () => document.getElementById(LIVE_VOICE_CONVERSATION_WINDOW_ID)?.querySelector<HTMLElement>(".window-close-button") ?? undefined
    items.push({
      key: "conversation",
      label: voiceMenuLabel(t("voice.command.conversation"), reason?.text),
      icon: running ? <CheckSquare class="h-4 w-4" aria-hidden="true" /> : <Square class="h-4 w-4" aria-hidden="true" />,
      checked: running,
      disabled: dictationMode() || Boolean(reason && !reason.row),
      selectBeforeClose: liveEngine && !reason && !running && !retained && !liveVoice.needsConsent(),
      focusAfterSelect: focusLiveWindow,
      onSelect: reason ? () => { if (reason.row) openSettingsRow("speech", reason.row) }
        : !liveEngine ? () => toggleConversationMode(props.instanceId)
        : running ? () => liveVoice.state().phase === "consent" ? liveVoice.dismiss() : liveVoice.stop()
        : retained ? () => focusLiveWindow()?.focus()
        : () => { liveVoice.start() },
    })
    items.push({
      key: "attach",
      label: t(isReadingFiles() ? "promptInput.attachFiles.reading" : "promptInput.attachFiles.title"),
      description: t("promptInput.attachFiles.help"),
      icon: isReadingFiles()
        ? <span class="inline-flex animate-spin"><Loader2 class="h-4 w-4" aria-hidden="true" /></span>
        : <Paperclip class="h-4 w-4" aria-hidden="true" />,
      disabled: Boolean(props.disabled) || isReadingFiles(),
      onSelect: handleUploadFiles,
    })
    for (const [direction, label, shortcut] of [["previous", "previousUserMessage", "user-message-prev"], ["next", "nextUserMessage", "user-message-next"]] as const) {
      const target = { instanceId: props.instanceId, sessionId: props.sessionId, direction }
      items.push({
        key: shortcut,
        label: t(`commands.${label}.label`),
        description: hotkeyLabel(shortcut) || undefined,
        icon: direction === "previous" ? <ArrowUp class="h-4 w-4" aria-hidden="true" /> : <ArrowDown class="h-4 w-4" aria-hidden="true" />,
        disabled: !canNavigateUserMessages(),
        onSelect: () => requestUserMessageJump(target),
      })
    }
    if (hasHistory()) {
      items.push({
        key: "history-previous",
        label: t("promptInput.history.previousAriaLabel"),
        description: hotkeyLabel("prompt-history-prev") || undefined,
        disabled: !canHistoryGoPrevious(),
        onSelect: () => { selectPreviousHistory({ force: true, isPickerOpen: showPicker(), getTextarea: () => textareaRef }) },
      })
      items.push({
        key: "history-next",
        label: t("promptInput.history.nextAriaLabel"),
        description: hotkeyLabel("prompt-history-next") || undefined,
        disabled: !canHistoryGoNext(),
        onSelect: () => { selectNextHistory({ force: true, isPickerOpen: showPicker(), getTextarea: () => textareaRef }) },
      })
    }
    items.push({
      key: "clear",
      label: t("promptInput.clear.title"),
      description: hotkeyLabel("clear-input") || undefined,
      icon: <X class="h-4 w-4" aria-hidden="true" />,
      disabled: !canClearPrompt(),
      onSelect: handleClearPrompt,
    })
    return items
  }

  // Memoized so composer-state updates (voice transcription ticks, drafts) do
  // not rebuild the item array and its icon DOM on every re-render.
  const promptActionMenuItems = createMemo(() => buildPromptActionMenuItems())

  return (
    <div class="prompt-input-container"
      data-keyboard-crowded={!props.interruptionExpanded && (viewport().fieldSpace ?? Infinity) < MIN_PROMPT_FIELD_HEIGHT ? "" : undefined}>
      <DictationNotice
        recordingLimitReached={voiceInput.state() === "limitReached"}
        focusDraft={() => textareaRef?.focus({ preventScroll: true })}
        onTranscribe={voiceInput.confirmTranscription} onCancelRecording={voiceInput.cancelRecording}
        transcript={voiceInput.savedTranscript()} canInsertTranscript={canInsertTranscript()}
        onInsertTranscript={voiceInput.restoreTranscript} onDiscardTranscript={voiceInput.discardTranscript}
      />
      <div
        ref={wrapperRef}
        class={`prompt-input-wrapper relative ${isDragging() ? "border-2" : ""}`}
        data-compact-auto={compactLayoutEnabled() ? "true" : undefined}
        style={
          isDragging()
            ? "border-color: var(--accent-primary); background-color: color-mix(in oklab, var(--accent-primary) 5%, transparent);"
            : ""
        }
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div
          class={`prompt-resize-handle ${isResizing() ? "is-resizing" : ""}`}
          onPointerDown={handleResizeStart}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeEnd}
          onPointerCancel={handleResizeEnd}
          onDblClick={handleResizeMaximize}
          onKeyDown={handleResizeKeyDown}
          tabIndex={props.interruptionExpanded ? -1 : 0}
          aria-disabled={props.interruptionExpanded || undefined}
          role="separator"
          aria-orientation="horizontal"
          aria-valuemin={props.interruptionExpanded ? effectiveInputHeight() : minimumFieldHeight()}
          aria-valuemax={computeMaxFieldHeight()}
          aria-valuenow={props.interruptionExpanded ? effectiveInputHeight() : desiredFieldHeight()}
          aria-label={t("promptInput.resizeHandle.title")}
          title={t("promptInput.resizeHandle.title")}
        />
        <Show when={showPicker() && instance() && props.instanceFolder} keyed>{(directory) =>
          <Suspense fallback={null}>
            <LazyUnifiedPicker
              open={showPicker()}
              mode={pickerMode()}
              onClose={handlePickerClose}
              onSelect={handlePickerSelect}
              agents={instanceAgents()}
              commands={promptCommands()}
              searchQuery={searchQuery()}
              textareaRef={textareaRef}
              workspaceId={props.instanceId}
              directory={directory}
            />
          </Suspense>
        }</Show>

        <div class="prompt-input-main flex flex-1 flex-col">
          <div
            class="prompt-input-field-container is-resized"
            style={fieldHeightStyle()}
          >
            <div
              class="prompt-input-field"
              data-prompt-help={shouldShowOverlay()}
              style={fieldHeightStyle()}
            >
              <textarea
                ref={(element) => {
                  textareaRef = element
                  element.addEventListener("selectionchange", voiceInput.selectionChanged)
                  // The Clear shortcut and palette command run this composer's own Clear action.
                  element.addEventListener(PROMPT_CLEAR_EVENT, handleClearPrompt)
                }}
                class={`prompt-input ${mode() === "shell" ? "shell-mode" : ""}`}
                dir="auto"
                placeholder={getPlaceholder()}
                aria-describedby={shouldShowOverlay() ? helpId : undefined}
                value={prompt()}
                onInput={handleInput}
                onSelect={voiceInput.selectionChanged}
                onCompositionStart={() => voiceInput.setComposing(true)}
                onCompositionEnd={() => voiceInput.setComposing(false)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onFocus={() => setIsFocused(true)}
                onBlur={() => setIsFocused(false)}
                disabled={props.disabled}
                rows={compactLayoutEnabled() ? 1 : 5}
                spellcheck={false}
                autocorrect="off"
                autoCapitalize="off"
                autocomplete="off"
                style={fieldHeightStyle()}
              />
              <Show when={shouldShowOverlay()}>
                <div id={helpId} role="note" class={`prompt-input-overlay ${mode() === "shell" ? "shell-mode" : ""}`}>
                  <Show when={shouldShowAbortReminder()}>
                    <span role="status" class="prompt-overlay-text prompt-overlay-warning">
                      {t("promptInput.overlay.abortHint")}
                    </span>
                  </Show>
                  <Show when={prompt().length === 0 && attachments().length > 0}>
                    <span class="prompt-overlay-text prompt-overlay-muted">{t(attachments().length === 1 ? "promptInput.overlay.attachments.one" : "promptInput.overlay.attachments.other", { count: attachments().length })}</span>
                  </Show>
                  <Show when={mode() === "shell"}>
                    <span class="prompt-overlay-shell-active">{t("promptInput.overlay.shellModeActive")}</span>
                  </Show>
                </div>
              </Show>
            </div>
          </div>
        </div>

        <div class="prompt-input-footer">
          <div class="prompt-input-footer-context">{props.footerControls}</div>
          <div class="prompt-input-footer-actions">
            <Show when={isReadingFiles()}>
              <span role="status" class="text-xs text-secondary inline-flex items-center gap-1">
                <span class="inline-flex animate-spin"><Loader2 class="h-3 w-3" aria-hidden="true" /></span>
                {t("promptInput.attachFiles.reading")}
              </span>
            </Show>
            <Show when={dictationMode()}>
              <DictationButton
                title={voiceInput.buttonTitle()}
                state={voiceInput.state()}
                canStart={voiceInput.canStartRecording()}
                separateCapture={voiceInput.usesRemoteCapture()}
                start={beginVoiceInput}
                stop={voiceInput.stopRecording}
                cancel={voiceInput.cancelRecording}
              />
            </Show>
            <div class="prompt-actions-menu">
              <ActionOverflowMenu
                items={promptActionMenuItems()}
                label={t("messageItem.actions.more")}
                triggerClass="prompt-actions-menu-trigger"
                onOpenChange={open => { if (open) void refreshMicrophoneUse() }}
              />
            </div>

            <div class="prompt-input-primary-actions">
              <button
                type="button"
                class="stop-button"
                onClick={handleAbort}
                disabled={!canStop()}
                aria-label={t("promptInput.stopSession.ariaLabel")}
                title={withHotkey(t("promptInput.stopSession.title"), "session-abort")}
              >
                <svg class="stop-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <rect x="4" y="4" width="12" height="12" />
                </svg>
              </button>
              <button
                type="button"
                class={`send-button ${mode() === "shell" ? "shell-mode" : ""}`}
                onClick={() => void handleSend()}
                disabled={!canSend()}
                aria-label={t(mode() === "normal" && promptDelivery() === "queue" ? "promptInput.send.queueAriaLabel" : "promptInput.send.ariaLabel")}
                title={withHotkey(t(mode() === "normal" && promptDelivery() === "queue" ? "promptInput.send.queueAriaLabel" : "promptInput.send.ariaLabel"), "prompt-send")}
              >
                <Show
                  when={mode() === "shell"}
                  fallback={<span class="send-icon">▶</span>}
                >
                  <svg class="shell-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M5 8l5 4-5 4" />
                    <path stroke-linecap="round" stroke-linejoin="round" d="M13 16h6" />
                  </svg>
                </Show>
              </button>
            </div>
          </div>
          <Show when={props.footerCornerRef}>
            {(ref) => <div class="session-scroll-corner" ref={ref()} />}
          </Show>
        </div>
      </div>

      <PromptAsideWindow id={asideId} controller={aside} returnFocus={() => textareaRef} />
      <LiveVoiceConversationWindow controller={liveVoice} targetLabel={liveVoiceTargetLabel()}
        returnFocus={() => wrapperRef?.querySelector<HTMLElement>(".prompt-actions-menu-trigger") ?? undefined} />
    </div>
  )
}
