import { Suspense, createEffect, createSignal, lazy, on, onCleanup, onMount, Show } from "solid-js"
import { Loader2, Mic, Paperclip, Volume2, X } from "lucide-solid"
import { addAttachment, clearAttachments, removeAttachment } from "../stores/attachments"
import { createPastedPlaceholderRegex, pastedDisplayCounterRegex } from "./prompt-input/attachmentPlaceholders"
import { preparePromptSubmission, resolvePromptDelivery } from "./prompt-input/submitPrompt"
import { focusConversationStream } from "./focus-conversation"
import Kbd from "./kbd"
import { getActiveInstance } from "../stores/instances"
import { agents, executeCustomCommand } from "../stores/sessions"
import { getCommands } from "../stores/commands"
import { showAlertDialog } from "../stores/alerts"
import { useI18n } from "../lib/i18n"
import { getLogger } from "../lib/logger"
import { getOpencodeErrorMessage } from "../lib/opencode-api"
import { serverApi } from "../lib/api-client"
import { isDesktopHost, isLocalWindow } from "../lib/runtime-env"
import { preferences } from "../stores/preferences"
import type { PromptDelivery, PromptInputApi, PromptInputProps, PromptInsertMode, PromptMode } from "./prompt-input/types"
import type { Attachment } from "../types/attachment"
import type { FileSystemEntry } from "../../../server/src/api-types"
import DirectoryBrowserDialog from "./directory-browser-dialog"
import { usePromptState } from "./prompt-input/usePromptState"
import { usePromptAttachments } from "./prompt-input/usePromptAttachments"
import { usePromptPicker } from "./prompt-input/usePromptPicker"
import { usePromptKeyDown } from "./prompt-input/usePromptKeyDown"
import { usePromptVoiceInput } from "./prompt-input/usePromptVoiceInput"
import {
  canUseConversationMode,
  clearConversationPlaybackForInstance,
  isConversationModeEnabled,
  toggleConversationMode,
} from "../stores/conversation-speech"
import ActionOverflowMenu, { type ActionOverflowMenuItem } from "./action-overflow-menu"
const log = getLogger("actions")
const LazyUnifiedPicker = lazy(() => import("./unified-picker"))
const DEFAULT_PROMPT_FIELD_HEIGHT = 104
const MAX_PROMPT_FIELD_HEIGHT_RATIO = 0.6
type SessionCenterWidthStep = "narrow" | "medium" | "wide"

function getSessionCenterWidthStep(width: number): SessionCenterWidthStep {
  if (width < 768) return "narrow"
  if (width < 1280) return "medium"
  return "wide"
}

type ResizeDragState = {
  pointerId: number
  startY: number
  startHeight: number
  maxHeight: number
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
  const [, setIsFocused] = createSignal(false)
  const [mode, setMode] = createSignal<PromptMode>("normal")
  const [inputHeight, setInputHeight] = createSignal<number | null>(null)
  const [autoInputHeight, setAutoInputHeight] = createSignal<number | null>(null)
  const [isResizing, setIsResizing] = createSignal(false)
  const [sessionCenterWidthStep, setSessionCenterWidthStep] = createSignal<SessionCenterWidthStep | null>(null)
  const [isFileBrowserOpen, setIsFileBrowserOpen] = createSignal(false)
  const SELECTION_INSERT_MAX_LENGTH = 2000
  const MAX_READABLE_PICKED_FILE_BYTES = 5 * 1024 * 1024
  let textareaRef: HTMLTextAreaElement | undefined
  let fileInputRef: HTMLInputElement | undefined
  let wrapperRef: HTMLDivElement | undefined
  let fieldContainerRef: HTMLDivElement | undefined
  let resizeDragState: ResizeDragState | undefined
  let submissionsInFlight = 0
  let restoredQueuedPayload: Parameters<PromptInputApi["restoreQueuedPrompt"]>[1] | undefined

  const getPlaceholder = () => {
    if (mode() === "shell") {
      return t("promptInput.placeholder.shell")
    }
    return t("promptInput.placeholder.default")
  }

  const compactAutosizeEnabled = () => {
    return compactLayoutEnabled() && inputHeight() === null
  }

  const compactLayoutEnabled = () => props.compactLayout && sessionCenterWidthStep() === "narrow"

  const effectiveInputHeight = () => inputHeight() ?? autoInputHeight()

  const fieldHeightStyle = () => {
    const height = effectiveInputHeight()
    if (height === null) return undefined
    if (inputHeight() !== null) return { height: `${height}px`, "min-height": `${height}px` }
    return { height: `${height}px` }
  }

  const textareaHeightStyle = () => {
    const height = effectiveInputHeight()
    if (height === null) return undefined
    const overflowY: "auto" | "hidden" = inputHeight() !== null || height >= DEFAULT_PROMPT_FIELD_HEIGHT ? "auto" : "hidden"
    if (inputHeight() !== null) {
      return {
        height: `${height}px`,
        "min-height": `${height}px`,
        "overflow-y": overflowY,
      }
    }
    return { height: `${height}px`, "overflow-y": overflowY }
  }

  const measureCompactAutoHeight = () => {
    const textarea = textareaRef
    if (!textarea) return null

    const previousHeight = textarea.style.height
    textarea.style.height = "auto"
    const measuredHeight = textarea.scrollHeight
    textarea.style.height = previousHeight
    return Math.min(DEFAULT_PROMPT_FIELD_HEIGHT, measuredHeight)
  }

  const syncCompactAutoHeight = () => {
    if (!compactLayoutEnabled()) {
      setAutoInputHeight(null)
      return
    }
    const measuredHeight = measureCompactAutoHeight()
    if (inputHeight() !== null) {
      setAutoInputHeight(null)
      if (measuredHeight !== null && inputHeight()! < measuredHeight) setInputHeight(measuredHeight)
      return
    }
    setAutoInputHeight(measuredHeight)
  }

  const promptState = usePromptState({
    instanceId: () => props.instanceId,
    sessionId: () => props.sessionId,
    instanceFolder: () => props.instanceFolder,
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

  onMount(() => {
    const sessionCenter = wrapperRef?.closest("[data-session-center-width]") as HTMLElement | null
    if (!sessionCenter) return

    const syncWidthStep = () => {
      setSessionCenterWidthStep(getSessionCenterWidthStep(sessionCenter.getBoundingClientRect().width))
    }

    syncWidthStep()

    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(syncWidthStep)
    observer.observe(sessionCenter)
    onCleanup(() => observer.disconnect())
  })

  createEffect(() => {
    prompt()
    inputHeight()
    props.compactLayout
    sessionCenterWidthStep()
    queueMicrotask(syncCompactAutoHeight)
  })

  const {
    attachments,
    isDragging,
    handlePaste,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleFileSelection,
    handleFilePathAttachment,
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
    commands: () => getCommands(props.instanceId),
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
        setInputHeight(null)
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
      const activeElement = document.activeElement as HTMLElement | null
      const targetElement = e.target instanceof HTMLElement ? e.target : null

      const isEditableElement = (element: HTMLElement | null) =>
        element?.tagName === "INPUT" ||
        element?.tagName === "TEXTAREA" ||
        element?.tagName === "SELECT" ||
        Boolean(element?.isContentEditable)

      const isInteractiveElement = (element: HTMLElement | null) =>
        Boolean(
          element?.closest(
            'button, a[href], summary, [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], [tabindex]:not([tabindex="-1"])',
          ),
        )

      if (
        isEditableElement(activeElement) ||
        isEditableElement(targetElement) ||
        isInteractiveElement(activeElement) ||
        isInteractiveElement(targetElement)
      ) {
        return
      }

      const isModifierKey = e.ctrlKey || e.metaKey || e.altKey
      if (isModifierKey) return

      const isSpecialKey =
        e.key === "Tab" ||
        e.key === "Enter" ||
        e.key === " " ||
        e.key === "Spacebar" ||
        e.key.startsWith("Arrow") ||
        e.key === "Backspace" ||
        e.key === "Delete"
      if (isSpecialKey) return

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

      if (e.key.length === 1) {
        textarea.focus()
      }
    }

    document.addEventListener("keydown", handleGlobalKeyDown)
    onCleanup(() => {
      document.removeEventListener("keydown", handleGlobalKeyDown)
    })
  })

  function computeMaxFieldHeight(): number {
    if (typeof window === "undefined") return DEFAULT_PROMPT_FIELD_HEIGHT

    const sessionCenter = wrapperRef?.closest("[data-session-center-width]")
    const availableHeight = sessionCenter?.getBoundingClientRect().height ?? window.innerHeight
    const maxHeight = Math.floor(availableHeight * MAX_PROMPT_FIELD_HEIGHT_RATIO)
    return Math.max(DEFAULT_PROMPT_FIELD_HEIGHT, maxHeight)
  }

  function handleResizeStart(event: PointerEvent) {
    event.preventDefault()
    const target = event.currentTarget as HTMLElement

    resizeDragState = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: fieldContainerRef?.getBoundingClientRect().height ?? DEFAULT_PROMPT_FIELD_HEIGHT,
      maxHeight: computeMaxFieldHeight(),
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
    if (!resizeDragState || resizeDragState.pointerId !== event.pointerId) return

    event.preventDefault()
    const deltaY = resizeDragState.startY - event.clientY
    const nextHeight = Math.max(
      DEFAULT_PROMPT_FIELD_HEIGHT,
      Math.min(resizeDragState.maxHeight, resizeDragState.startHeight + deltaY),
    )
    setInputHeight(nextHeight)
  }

  function handleResizeEnd(event: PointerEvent) {
    if (!resizeDragState || resizeDragState.pointerId !== event.pointerId) return

    event.preventDefault()
    resizeDragState = undefined
    setIsResizing(false)
    textareaRef?.focus()
  }

  function handleResizeKeyDown(event: KeyboardEvent) {
    const currentHeight = inputHeight() ?? fieldContainerRef?.getBoundingClientRect().height ?? DEFAULT_PROMPT_FIELD_HEIGHT
    const minimum = compactLayoutEnabled() ? measureCompactAutoHeight() ?? currentHeight : DEFAULT_PROMPT_FIELD_HEIGHT
    const current = Math.max(minimum, currentHeight)
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
    setInputHeight(next)
  }

  onCleanup(() => {
    resizeDragState = undefined
  })

  const promptDelivery = (alternate = false) => resolvePromptDelivery(
    Boolean(props.isSessionBusy || submissionsInFlight > 0),
    preferences().followUpBehavior,
    alternate,
  )

  async function handleSend(delivery?: PromptDelivery) {
    const draftText = prompt()
    const text = draftText.trim()
    const currentAttachments = attachments()
    if (props.disabled || submissionsInFlight > 0 || (!text && currentAttachments.length === 0)) return
    const resolvedDelivery = delivery ?? promptDelivery()
    const restoredPayload = restoredQueuedPayload

    const isShellMode = mode() === "shell"

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

    setInputHeight(null)
    clearPrompt()
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
    void refreshHistory()

    if (!isTouchOnlyPointer()) {
      focusConversationStream(wrapperRef?.closest(".session-view"))
    }

    submissionsInFlight += 1
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
        await props.onSend(submitPrompt, currentAttachments, resolvedDelivery, restoredPayload)
      }
      restoredQueuedPayload = undefined
    } catch (error) {
      log.error("Failed to send message:", error)
      if (!prompt()) {
        setPrompt(draftText)
        restoredQueuedPayload = restoredPayload
        if (attachments().length === 0) {
          for (const attachment of currentAttachments) addAttachment(props.instanceId, props.sessionId, attachment)
        }
      }
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
      submissionsInFlight -= 1
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
    setInputHeight(computeMaxFieldHeight())
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

  async function handleAttachFiles() {
    if (props.disabled) return
    if (isDesktopHost() && isLocalWindow()) {
      fileInputRef?.click()
      return
    }
    setIsFileBrowserOpen(true)
  }

  async function handleFileBrowserSelect(path: string, entry?: FileSystemEntry) {
    if (props.disabled) return
    if (typeof entry?.size === "number" && entry.size > MAX_READABLE_PICKED_FILE_BYTES) {
      showAlertDialog(t("promptInput.attachFiles.tooLarge.one"), {
        title: t("promptInput.attachFiles.skipped.title"),
        variant: "warning",
      })
      textareaRef?.focus()
      return
    }
    try {
      const filePath = entry?.path ?? path
      const displayPath = entry?.absolutePath ?? path
      const response = await serverApi.readFileSystemFile(filePath, { encoding: "base64" })
      handleFilePathAttachment(displayPath, response.contents, { encoding: response.encoding })
      setIsFileBrowserOpen(false)
    } catch (error) {
      log.error("Failed to attach selected file:", error)
      showAlertDialog(error instanceof Error ? error.message : String(error), {
        title: t("promptInput.attachFiles.errorTitle"),
        variant: "error",
      })
    } finally {
      textareaRef?.focus()
    }
  }

  function handleFileInputChange(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    if (props.disabled) {
      input.value = ""
      return
    }
    handleFileSelection(input.files)
    input.value = ""
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
    if (props.disabled) return false
    const hasText = prompt().trim().length > 0
    if (mode() === "shell") return hasText
    return hasText || attachments().length > 0
  }

  const canClearPrompt = () => prompt().length > 0

  const shellHint = () =>
    mode() === "shell"
      ? { key: "Esc", text: t("promptInput.hints.shell.exit") }
      : { key: "!", text: t("promptInput.hints.shell.enable") }
  const commandHint = () => ({ key: "/", text: t("promptInput.hints.commands") })

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
    onSend: (alternate) => void handleSend(promptDelivery(Boolean(alternate))),
    onBackground: handleBackground,
    selectPreviousHistory: (force) =>
      selectPreviousHistory({ force, isPickerOpen: showPicker(), getTextarea: () => textareaRef ?? null }),
    selectNextHistory: (force) =>
      selectNextHistory({ force, isPickerOpen: showPicker(), getTextarea: () => textareaRef ?? null }),
  })

  const shouldShowOverlay = () => prompt().length === 0
  const voiceInput = usePromptVoiceInput({
    prompt,
    setPrompt,
    getTextarea: () => textareaRef ?? null,
    enabled: () => preferences().showPromptVoiceInput,
    disabled: () => Boolean(props.disabled),
  })
  const showVoiceInput = () =>
    preferences().showPromptVoiceInput &&
    (voiceInput.canUseVoiceInput() || voiceInput.isRecording() || voiceInput.isTranscribing())
  const conversationModeEnabled = () => isConversationModeEnabled(props.instanceId)
  const showConversationToggle = () => showVoiceInput() || conversationModeEnabled()
  const canToggleConversationMode = () => canUseConversationMode()
  const conversationModeButtonTitle = () =>
    conversationModeEnabled()
      ? t("promptInput.conversationMode.disable.title")
      : t("promptInput.conversationMode.enable.title")

  const instance = () => getActiveInstance()

  let voiceButtonPressed = false

  const beginVoicePress = (event?: PointerEvent | KeyboardEvent) => {
    if (voiceButtonPressed || props.disabled || voiceInput.isTranscribing() || !voiceInput.canUseVoiceInput()) return
    voiceButtonPressed = true
    // Treat a mic press as barge-in: stop any active assistant speech before listening.
    clearConversationPlaybackForInstance(props.instanceId)

    if (event instanceof PointerEvent) {
      const target = event.currentTarget
      if (target instanceof HTMLElement) {
        try {
          target.setPointerCapture(event.pointerId)
        } catch {
          // no-op
        }
      }
    }

    void voiceInput.startRecording().then(() => {
      if (!voiceInput.isRecording()) voiceButtonPressed = false
    })
  }

  const endVoicePress = () => {
    if (!voiceButtonPressed) return
    voiceButtonPressed = false
    voiceInput.stopRecording()
  }

  const promptActionMenuItems = (): ActionOverflowMenuItem[] => {
    const items: ActionOverflowMenuItem[] = []
    if (showVoiceInput()) {
      items.push({
        key: "voice",
        label: voiceInput.buttonTitle(),
        icon: voiceInput.isTranscribing()
          ? <Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" />
          : <Mic class="h-4 w-4" aria-hidden="true" />,
        disabled: !voiceInput.isRecording() && (Boolean(props.disabled) || voiceInput.isTranscribing() || !voiceInput.canUseVoiceInput()),
        onSelect: () => voiceInput.isRecording() ? endVoicePress() : beginVoicePress(),
      })
    }
    if (showConversationToggle()) {
      items.push({
        key: "conversation",
        label: conversationModeButtonTitle(),
        icon: <Volume2 class="h-4 w-4" aria-hidden="true" />,
        checked: conversationModeEnabled(),
        disabled: !conversationModeEnabled() && !canToggleConversationMode(),
        onSelect: () => toggleConversationMode(props.instanceId),
      })
    }
    items.push({
      key: "attach",
      label: t("promptInput.attachFiles.title"),
      icon: <Paperclip class="h-4 w-4" aria-hidden="true" />,
      disabled: Boolean(props.disabled),
      onSelect: handleAttachFiles,
    })
    if (hasHistory()) {
      items.push({
        key: "history-previous",
        label: t("promptInput.history.previousAriaLabel"),
        disabled: !canHistoryGoPrevious(),
        onSelect: () => { selectPreviousHistory({ force: true, isPickerOpen: showPicker(), getTextarea: () => textareaRef }) },
      })
      items.push({
        key: "history-next",
        label: t("promptInput.history.nextAriaLabel"),
        disabled: !canHistoryGoNext(),
        onSelect: () => { selectNextHistory({ force: true, isPickerOpen: showPicker(), getTextarea: () => textareaRef }) },
      })
    }
    items.push({
      key: "clear",
      label: t("promptInput.clear.title"),
      icon: <X class="h-4 w-4" aria-hidden="true" />,
      disabled: !canClearPrompt(),
      onSelect: handleClearPrompt,
    })
    return items
  }

  return (
    <div class="prompt-input-container">
      <div
        ref={wrapperRef}
        class={`prompt-input-wrapper relative ${isDragging() ? "border-2" : ""}`}
        data-compact-auto={compactLayoutEnabled() ? "true" : undefined}
        style={
          isDragging()
            ? "border-color: var(--accent-primary); background-color: rgba(0, 102, 255, 0.05);"
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
          tabIndex={0}
          role="separator"
          aria-orientation="horizontal"
          aria-valuemin={Math.round(compactLayoutEnabled() ? measureCompactAutoHeight() ?? 0 : DEFAULT_PROMPT_FIELD_HEIGHT)}
          aria-valuemax={computeMaxFieldHeight()}
          aria-valuenow={Math.round(Math.max(
            compactLayoutEnabled() ? measureCompactAutoHeight() ?? 0 : DEFAULT_PROMPT_FIELD_HEIGHT,
            inputHeight() ?? autoInputHeight() ?? DEFAULT_PROMPT_FIELD_HEIGHT,
          ))}
          aria-label={t("promptInput.resizeHandle.title")}
          title={t("promptInput.resizeHandle.title")}
        />
        <Show when={showPicker() && instance()}>
          <Suspense fallback={null}>
            <LazyUnifiedPicker
              open={showPicker()}
              mode={pickerMode()}
              onClose={handlePickerClose}
              onSelect={handlePickerSelect}
              onSubmitWithoutSelection={() => {
                handlePickerClose()
                void handleSend()
              }}
              agents={instanceAgents()}
              commands={getCommands(props.instanceId)}
              searchQuery={searchQuery()}
              textareaRef={textareaRef}
              workspaceId={props.instanceId}
            />
          </Suspense>
        </Show>

        <div class="prompt-input-main flex flex-1 flex-col">
          <div
            ref={fieldContainerRef}
            class={`prompt-input-field-container ${effectiveInputHeight() !== null ? "is-resized" : ""}`}
            style={fieldHeightStyle()}
          >
            <div
              class="prompt-input-field"
              style={fieldHeightStyle()}
            >
              <textarea
                ref={textareaRef}
                class={`prompt-input ${mode() === "shell" ? "shell-mode" : ""}`}
                dir="auto"
                placeholder={getPlaceholder()}
                value={prompt()}
                onInput={handleInput}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onFocus={() => setIsFocused(true)}
                onBlur={() => setIsFocused(false)}
                disabled={props.disabled}
                rows={compactAutosizeEnabled() ? 1 : 5}
                spellcheck={false}
                autocorrect="off"
                autoCapitalize="off"
                autocomplete="off"
                style={textareaHeightStyle()}
              />
              <Show when={shouldShowOverlay()}>
                <div class={`prompt-input-overlay keyboard-hints ${mode() === "shell" ? "shell-mode" : ""}`}>
                  <Show
                    when={props.escapeInDebounce}
                    fallback={
                      <>
                        <span class="prompt-overlay-text">
                          <Show
                            when={submitOnEnter()}
                            fallback={
                              <>
                                <Kbd>Enter</Kbd> {t("promptInput.overlay.newLine")} • <Kbd shortcut="cmd+enter" /> {t("promptInput.overlay.send")}
                              </>
                            }
                          >
                            <>
                              <Kbd>Enter</Kbd> {t("promptInput.overlay.send")} • <Kbd shortcut="cmd+enter" /> {t("promptInput.overlay.newLine")}
                            </>
                          </Show>
                          {" "}• <Kbd>↑↓</Kbd> {t("promptInput.overlay.history")}
                        </span>
                        <Show when={attachments().length > 0}>
                          <span class="prompt-overlay-text prompt-overlay-muted">{t("promptInput.overlay.attachments", { count: attachments().length })}</span>
                        </Show>
                        <span class="prompt-overlay-text">
                          • <Kbd>{shellHint().key}</Kbd> {shellHint().text}
                        </span>
                        <Show when={mode() !== "shell"}>
                          <span class="prompt-overlay-text">
                            • <Kbd>{commandHint().key}</Kbd> {commandHint().text}
                          </span>
                        </Show>
                        <Show when={mode() === "shell"}>
                          <span class="prompt-overlay-shell-active">{t("promptInput.overlay.shellModeActive")}</span>
                        </Show>
                      </>
                    }
                  >
                    <>
                      <span class="prompt-overlay-text prompt-overlay-warning">
                        {t("promptInput.overlay.press")} <Kbd>Esc</Kbd> {t("promptInput.overlay.againToAbort")}
                      </span>
                      <Show when={mode() === "shell"}>
                        <span class="prompt-overlay-shell-active">{t("promptInput.overlay.shellModeActive")}</span>
                      </Show>
                    </>
                  </Show>
                </div>
              </Show>
            </div>
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          class="sr-only"
          tabindex="-1"
          disabled={props.disabled}
          onChange={handleFileInputChange}
        />
        <div class="prompt-actions-menu">
          <ActionOverflowMenu
            items={promptActionMenuItems()}
            label={t("messageItem.actions.more")}
            triggerClass="prompt-actions-menu-trigger"
          />
        </div>

        <div class="prompt-input-primary-actions">
          <button
            type="button"
            class="stop-button"
            onClick={handleAbort}
            disabled={!canStop()}
            aria-label={t("promptInput.stopSession.ariaLabel")}
            title={t("promptInput.stopSession.title")}
          >
            <svg class="stop-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <rect x="4" y="4" width="12" height="12" rx="2" />
            </svg>
          </button>
          <button
            type="button"
            class={`send-button ${mode() === "shell" ? "shell-mode" : ""}`}
            onClick={() => void handleSend()}
            disabled={!canSend()}
            aria-label={t(mode() === "normal" && promptDelivery() === "queue" ? "promptInput.send.queueAriaLabel" : "promptInput.send.ariaLabel")}
            title={t(mode() === "normal" && promptDelivery() === "queue" ? "promptInput.send.queueAriaLabel" : "promptInput.send.ariaLabel")}
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

      <DirectoryBrowserDialog
        open={isFileBrowserOpen()}
        mode="files"
        title={t("promptInput.attachFiles.dialogTitle")}
        onClose={() => {
          setIsFileBrowserOpen(false)
          textareaRef?.focus()
        }}
        onSelect={(path, entry) => void handleFileBrowserSelect(path, entry)}
        initialPath={props.instanceFolder}
      />
    </div>
  )
}
