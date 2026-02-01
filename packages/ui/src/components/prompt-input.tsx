import { createSignal, Show, onMount, For, onCleanup, createEffect, on, untrack } from "solid-js"
import { ArrowBigUp, ArrowBigDown, ArrowLeft } from "lucide-solid"
import UnifiedPicker from "./unified-picker"
import SlashCommandPicker from "./slash-command-picker"
import ExpandButton from "./expand-button"
import { addToHistory, getHistory } from "../stores/message-history"
import { getAttachments, addAttachment, clearAttachments, removeAttachment } from "../stores/attachments"
import { resolvePastedPlaceholders } from "../lib/prompt-placeholders"
import { createFileAttachment, createTextAttachment, createAgentAttachment } from "../types/attachment"
import type { Attachment } from "../types/attachment"
import type { Agent } from "../types/session"
import type { Command as SDKCommand } from "@opencode-ai/sdk"
import Kbd from "./kbd"
import { getActiveInstance } from "../stores/instances"
import { agents, getSessionDraftPrompt, setSessionDraftPrompt, clearSessionDraftPrompt } from "../stores/sessions"
import { showAlertDialog } from "../stores/alerts"
import { executeCustomCommand } from "../stores/session-actions"
import { getLogger } from "../lib/logger"
import { cn } from "../lib/cn"
import { Button } from "./ui"
const log = getLogger("actions")


interface PromptInputProps {
  instanceId: string
  instanceFolder: string
  sessionId: string
  onSend: (prompt: string, attachments: Attachment[]) => Promise<void>
  onRunShell?: (command: string) => Promise<void>
  disabled?: boolean
  escapeInDebounce?: boolean
  isSessionBusy?: boolean
  onAbortSession?: () => Promise<void>
  registerQuoteHandler?: (handler: (text: string, mode: "quote" | "code") => void) => void | (() => void)
  isSubAgentSession?: boolean  // If true, show read-only footer instead of input
  parentSessionTitle?: string  // Title of parent session for "return to" button
  onReturnToParent?: () => void  // Handler to return to parent session
  hasActiveQuestion?: boolean  // If true, a Question tool is awaiting user input
}

export default function PromptInput(props: PromptInputProps) {
  const [prompt, setPromptInternal] = createSignal("")
  const [history, setHistory] = createSignal<string[]>([])
  const HISTORY_LIMIT = 100
  const [historyIndex, setHistoryIndex] = createSignal(-1)
  const [historyDraft, setHistoryDraft] = createSignal<string | null>(null)
  const [, setIsFocused] = createSignal(false)
  const [showPicker, setShowPicker] = createSignal(false)
  const [searchQuery, setSearchQuery] = createSignal("")
  const [atPosition, setAtPosition] = createSignal<number | null>(null)
  const [isDragging, setIsDragging] = createSignal(false)
  const [ignoredAtPositions, setIgnoredAtPositions] = createSignal<Set<number>>(new Set<number>())
  const [pasteCount, setPasteCount] = createSignal(0)
  const [imageCount, setImageCount] = createSignal(0)
  const [mode, setMode] = createSignal<"normal" | "shell">("normal")
  const [expandState, setExpandState] = createSignal<"normal" | "expanded">("normal")
  const [showSlashPicker, setShowSlashPicker] = createSignal(false)
  const [slashQuery, setSlashQuery] = createSignal("")
  const SELECTION_INSERT_MAX_LENGTH = 2000
  let textareaRef: HTMLTextAreaElement | undefined
  let containerRef: HTMLDivElement | undefined




  const attachments = () => getAttachments(props.instanceId, props.sessionId)
  const instanceAgents = () => agents().get(props.instanceId) || []

  createEffect(() => {
    if (!props.registerQuoteHandler) return
    const cleanup = props.registerQuoteHandler((text, mode) => {
      if (mode === "code") {
        insertCodeSelection(text)
      } else {
        insertQuotedSelection(text)
      }
    })
    onCleanup(() => {
      if (typeof cleanup === "function") {
        cleanup()
      }
    })
  })

  const setPrompt = (value: string) => {
    setPromptInternal(value)
    setSessionDraftPrompt(props.instanceId, props.sessionId, value)
  }

  const clearPrompt = () => {
    clearSessionDraftPrompt(props.instanceId, props.sessionId)
    setPromptInternal("")
    setHistoryDraft(null)
    setMode("normal")
  }

  function syncAttachmentCounters(currentPrompt: string, sessionAttachments: Attachment[]) {
    let highestPaste = 0
    let highestImage = 0

    for (const match of currentPrompt.matchAll(/\[pasted #(\d+)\]/g)) {
      const value = Number.parseInt(match[1], 10)
      if (!Number.isNaN(value)) {
        highestPaste = Math.max(highestPaste, value)
      }
    }

    for (const attachment of sessionAttachments) {
      if (attachment.source.type === "text") {
        const placeholderMatch = attachment.display.match(/pasted #(\d+)/)
        if (placeholderMatch) {
          const value = Number.parseInt(placeholderMatch[1], 10)
          if (!Number.isNaN(value)) {
            highestPaste = Math.max(highestPaste, value)
          }
        }
      }
      if (attachment.source.type === "file" && attachment.mediaType.startsWith("image/")) {
        const imageMatch = attachment.display.match(/Image #(\d+)/)
        if (imageMatch) {
          const value = Number.parseInt(imageMatch[1], 10)
          if (!Number.isNaN(value)) {
            highestImage = Math.max(highestImage, value)
          }
        }
      }
    }

    for (const match of currentPrompt.matchAll(/\[Image #(\d+)\]/g)) {
      const value = Number.parseInt(match[1], 10)
      if (!Number.isNaN(value)) {
        highestImage = Math.max(highestImage, value)
      }
    }

    setPasteCount(highestPaste)
    setImageCount(highestImage)
  }

  createEffect(
    on(
      () => `${props.instanceId}:${props.sessionId}`,
      () => {
        const instanceId = props.instanceId
        const sessionId = props.sessionId

        onCleanup(() => {
          setSessionDraftPrompt(instanceId, sessionId, prompt())
        })

        const storedPrompt = getSessionDraftPrompt(instanceId, sessionId)
        const currentAttachments = untrack(() => getAttachments(instanceId, sessionId))

        setPromptInternal(storedPrompt)
        setSessionDraftPrompt(instanceId, sessionId, storedPrompt)
        setHistoryIndex(-1)
        setHistoryDraft(null)
        setIgnoredAtPositions(new Set<number>())
        setShowPicker(false)
        setAtPosition(null)
        setSearchQuery("")
        syncAttachmentCounters(storedPrompt, currentAttachments)
      }
    )
  )

  function handleRemoveAttachment(attachmentId: string) {
    const currentAttachments = attachments()
    const attachment = currentAttachments.find((a) => a.id === attachmentId)

    removeAttachment(props.instanceId, props.sessionId, attachmentId)

    if (attachment) {
      const currentPrompt = prompt()
      let newPrompt = currentPrompt

      if (attachment.source.type === "file") {
        if (attachment.mediaType.startsWith("image/")) {
          const imageMatch = attachment.display.match(/\[Image #(\d+)\]/)
          if (imageMatch) {
            const placeholder = `[Image #${imageMatch[1]}]`
            newPrompt = currentPrompt.replace(placeholder, "").replace(/\s+/g, " ").trim()
          }
        } else {
          const filename = attachment.filename
          newPrompt = currentPrompt.replace(`@${filename}`, "").replace(/\s+/g, " ").trim()
        }
      } else if (attachment.source.type === "agent") {
        const agentName = attachment.filename
        newPrompt = currentPrompt.replace(`@${agentName}`, "").replace(/\s+/g, " ").trim()
      } else if (attachment.source.type === "text") {
        const placeholderMatch = attachment.display.match(/pasted #(\d+)/)
        if (placeholderMatch) {
          const placeholder = `[pasted #${placeholderMatch[1]}]`
          newPrompt = currentPrompt.replace(placeholder, "").replace(/\s+/g, " ").trim()
        }
      }

      setPrompt(newPrompt)
    }
  }

  function handleExpandTextAttachment(attachment: Attachment) {
    if (attachment.source.type !== "text") return

    const textarea = textareaRef
    const value = attachment.source.value
    const match = attachment.display.match(/pasted #(\d+)/)
    const placeholder = match ? `[pasted #${match[1]}]` : null
    const currentText = prompt()

    let nextText = currentText
    let selectionTarget: number | null = null

    if (placeholder) {
      const placeholderIndex = currentText.indexOf(placeholder)
      if (placeholderIndex !== -1) {
        nextText =
          currentText.substring(0, placeholderIndex) +
          value +
          currentText.substring(placeholderIndex + placeholder.length)
        selectionTarget = placeholderIndex + value.length
      }
    }

    if (nextText === currentText) {
      if (textarea) {
        const start = textarea.selectionStart
        const end = textarea.selectionEnd
        nextText = currentText.substring(0, start) + value + currentText.substring(end)
        selectionTarget = start + value.length
      } else {
        nextText = currentText + value
      }
    }

    setPrompt(nextText)
    removeAttachment(props.instanceId, props.sessionId, attachment.id)

    if (textarea) {
      setTimeout(() => {
        textarea.focus()
        if (selectionTarget !== null) {
          textarea.setSelectionRange(selectionTarget, selectionTarget)
        }
      }, 0)
    }
  }

  async function handlePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items
    if (!items) return

    for (let i = 0; i < items.length; i++) {
      const item = items[i]

      if (item.type.startsWith("image/")) {
        e.preventDefault()

        const blob = item.getAsFile()
        if (!blob) continue

        const count = imageCount() + 1
        setImageCount(count)

        const reader = new FileReader()
        reader.onload = () => {
          const base64Data = (reader.result as string).split(",")[1]
          const display = `[Image #${count}]`
          const filename = `image-${count}.png`

          const attachment = createFileAttachment(
            filename,
            filename,
            "image/png",
            new TextEncoder().encode(base64Data),
            props.instanceFolder,
          )
          attachment.url = `data:image/png;base64,${base64Data}`
          attachment.display = display
          addAttachment(props.instanceId, props.sessionId, attachment)

          const textarea = textareaRef
          if (textarea) {
            const start = textarea.selectionStart
            const end = textarea.selectionEnd
            const currentText = prompt()
            const placeholder = `[Image #${count}]`
            const newText = currentText.substring(0, start) + placeholder + currentText.substring(end)
            setPrompt(newText)

            setTimeout(() => {
              const newCursorPos = start + placeholder.length
              textarea.setSelectionRange(newCursorPos, newCursorPos)
              textarea.focus()
            }, 0)
          }
        }
        reader.readAsDataURL(blob)

        return
      }
    }

    const pastedText = e.clipboardData?.getData("text/plain")
    if (!pastedText) return

    const lineCount = pastedText.split("\n").length
    const charCount = pastedText.length

    const isLongPaste = charCount > 150 || lineCount > 3

    if (isLongPaste) {
      e.preventDefault()

      const count = pasteCount() + 1
      setPasteCount(count)

      const summary = lineCount > 1 ? `${lineCount} lines` : `${charCount} chars`
      const display = `pasted #${count} (${summary})`
      const filename = `paste-${count}.txt`

      const attachment = createTextAttachment(pastedText, display, filename)
      addAttachment(props.instanceId, props.sessionId, attachment)

      const textarea = textareaRef
      if (textarea) {
        const start = textarea.selectionStart
        const end = textarea.selectionEnd
        const currentText = prompt()
        const placeholder = `[pasted #${count}]`
        const newText = currentText.substring(0, start) + placeholder + currentText.substring(end)
        setPrompt(newText)

        setTimeout(() => {
          const newCursorPos = start + placeholder.length
          textarea.setSelectionRange(newCursorPos, newCursorPos)
          textarea.focus()
        }, 0)
      }
    }
  }

  onMount(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const activeElement = document.activeElement as HTMLElement

      const isInputElement =
        activeElement?.tagName === "INPUT" ||
        activeElement?.tagName === "TEXTAREA" ||
        activeElement?.tagName === "SELECT" ||
        activeElement?.isContentEditable

      if (isInputElement) return

      const isModifierKey = e.ctrlKey || e.metaKey || e.altKey
      if (isModifierKey) return

      const isSpecialKey =
        e.key === "Tab" || e.key === "Enter" || e.key.startsWith("Arrow") || e.key === "Backspace" || e.key === "Delete"
      if (isSpecialKey) return

      if (e.key.length === 1 && textareaRef && !props.disabled) {
        textareaRef.focus()
      }
    }

    document.addEventListener("keydown", handleGlobalKeyDown)

    onCleanup(() => {
      document.removeEventListener("keydown", handleGlobalKeyDown)
    })

    void (async () => {
      const loaded = await getHistory(props.instanceFolder)
      setHistory(loaded)
    })()
  })

  function handleKeyDown(e: KeyboardEvent) {
    const textarea = textareaRef
    if (!textarea) {
      return
    }

    const currentText = prompt()
    const cursorAtBufferStart = textarea.selectionStart === 0 && textarea.selectionEnd === 0
    const isShellMode = mode() === "shell"

    if (!isShellMode && e.key === "!" && cursorAtBufferStart && currentText.length === 0 && !props.disabled) {
      e.preventDefault()
      setMode("shell")
      return
    }

    if (showPicker() && e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      handlePickerClose()
      return
    }

    if (showSlashPicker() && e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      handleSlashPickerClose()
      return
    }

    if (isShellMode) {
      if (e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
        setMode("normal")
        return
      }
      if (e.key === "Backspace" && cursorAtBufferStart && currentText.length === 0) {
        e.preventDefault()
        setMode("normal")
        return
      }
    }

    if (e.key === "Backspace" || e.key === "Delete") {
      const cursorPos = textarea.selectionStart
      const text = currentText

      const pastePlaceholderRegex = /\[pasted #(\d+)\]/g
      let pasteMatch

      while ((pasteMatch = pastePlaceholderRegex.exec(text)) !== null) {
        const placeholderStart = pasteMatch.index
        const placeholderEnd = pasteMatch.index + pasteMatch[0].length
        const pasteNumber = pasteMatch[1]

        const isDeletingFromEnd = e.key === "Backspace" && cursorPos === placeholderEnd
        const isDeletingFromStart = e.key === "Delete" && cursorPos === placeholderStart
        const isSelected =
          textarea.selectionStart <= placeholderStart &&
          textarea.selectionEnd >= placeholderEnd &&
          textarea.selectionStart !== textarea.selectionEnd

        if (isDeletingFromEnd || isDeletingFromStart || isSelected) {
          e.preventDefault()

          const currentAttachments = attachments()
          const attachment = currentAttachments.find(
            (a) => a.source.type === "text" && a.display.includes(`pasted #${pasteNumber}`),
          )

          if (attachment) {
            removeAttachment(props.instanceId, props.sessionId, attachment.id)
          }

          const newText = text.substring(0, placeholderStart) + text.substring(placeholderEnd)
          setPrompt(newText)

          setTimeout(() => {
            textarea.setSelectionRange(placeholderStart, placeholderStart)
          }, 0)

          return
        }
      }

      const imagePlaceholderRegex = /\[Image #(\d+)\]/g
      let imageMatch

      while ((imageMatch = imagePlaceholderRegex.exec(text)) !== null) {
        const placeholderStart = imageMatch.index
        const placeholderEnd = imageMatch.index + imageMatch[0].length
        const imageNumber = imageMatch[1]

        const isDeletingFromEnd = e.key === "Backspace" && cursorPos === placeholderEnd
        const isDeletingFromStart = e.key === "Delete" && cursorPos === placeholderStart
        const isSelected =
          textarea.selectionStart <= placeholderStart &&
          textarea.selectionEnd >= placeholderEnd &&
          textarea.selectionStart !== textarea.selectionEnd

        if (isDeletingFromEnd || isDeletingFromStart || isSelected) {
          e.preventDefault()

          const currentAttachments = attachments()
          const attachment = currentAttachments.find(
            (a) =>
              a.source.type === "file" &&
              a.mediaType.startsWith("image/") &&
              a.display.includes(`Image #${imageNumber}`),
          )

          if (attachment) {
            removeAttachment(props.instanceId, props.sessionId, attachment.id)
          }

          const newText = text.substring(0, placeholderStart) + text.substring(placeholderEnd)
          setPrompt(newText)

          setTimeout(() => {
            textarea.setSelectionRange(placeholderStart, placeholderStart)
          }, 0)

          return
        }
      }

      const mentionRegex = /@(\S+)/g
      let mentionMatch

      while ((mentionMatch = mentionRegex.exec(text)) !== null) {
        const mentionStart = mentionMatch.index
        const mentionEnd = mentionMatch.index + mentionMatch[0].length
        const name = mentionMatch[1]

        const isDeletingFromEnd = e.key === "Backspace" && cursorPos === mentionEnd
        const isDeletingFromStart = e.key === "Delete" && cursorPos === mentionStart
        const isSelected =
          textarea.selectionStart <= mentionStart &&
          textarea.selectionEnd >= mentionEnd &&
          textarea.selectionStart !== textarea.selectionEnd

        if (isDeletingFromEnd || isDeletingFromStart || isSelected) {
          const currentAttachments = attachments()
          const attachment = currentAttachments.find(
            (a) => (a.source.type === "file" || a.source.type === "agent") && a.filename === name,
          )

          if (attachment) {
            e.preventDefault()

            removeAttachment(props.instanceId, props.sessionId, attachment.id)

            setIgnoredAtPositions((prev) => {
              const next = new Set(prev)
              next.delete(mentionStart)
              return next
            })

            const newText = text.substring(0, mentionStart) + text.substring(mentionEnd)
            setPrompt(newText)

            setTimeout(() => {
              textarea.setSelectionRange(mentionStart, mentionStart)
            }, 0)

            return
          }
        }
      }
    }

    // Enter submits, Shift+Enter adds newline
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      if (showPicker()) {
        handlePickerClose()
      }
      if (showSlashPicker()) {
        // Let slash picker handle Enter
        return
      }
      handleSend()
      return
    }

    if (e.key === "ArrowUp") {
      const handled = selectPreviousHistory()
      if (handled) {
        e.preventDefault()
        return
      }
    }

    if (e.key === "ArrowDown") {
      const handled = selectNextHistory()
      if (handled) {
        e.preventDefault()
        return
      }
    }
  }

  async function handleSend() {
    const text = prompt().trim()
    const currentAttachments = attachments()
    if (props.disabled || (!text && currentAttachments.length === 0)) return

    // Close any open pickers
    if (showSlashPicker()) {
      setShowSlashPicker(false)
      setSlashQuery("")
    }
    if (showPicker()) {
      handlePickerClose()
    }

    const resolvedPrompt = resolvePastedPlaceholders(text, currentAttachments)
    const isShellMode = mode() === "shell"

    // Check if this is a slash command
    const isSlashCommand = !isShellMode && text.startsWith("/")
    let commandName = ""
    let commandArgs = ""

    if (isSlashCommand) {
      const firstSpace = text.indexOf(" ")
      const commandToken = firstSpace === -1 ? text : text.slice(0, firstSpace)
      commandName = commandToken.slice(1) // Remove leading /
      commandArgs = firstSpace === -1 ? "" : text.slice(firstSpace + 1).trim()
    }

    const refreshHistory = async () => {
      try {
        await addToHistory(props.instanceFolder, resolvedPrompt)
        setHistory((prev) => {
          const next = [resolvedPrompt, ...prev]
          if (next.length > HISTORY_LIMIT) {
            next.length = HISTORY_LIMIT
          }
          return next
        })
        setHistoryIndex(-1)
      } catch (historyError) {
        log.error("Failed to update prompt history:", historyError)
      }
    }

    setExpandState("normal")
    clearPrompt()
    // Don't clear attachments for slash commands - preserve them for next message
    if (!isSlashCommand) {
      clearAttachments(props.instanceId, props.sessionId)
    }
    setIgnoredAtPositions(new Set<number>())
    setPasteCount(0)
    setImageCount(0)
    setHistoryDraft(null)

    try {
      if (isShellMode) {
        if (props.onRunShell) {
          await props.onRunShell(resolvedPrompt)
        } else {
          await props.onSend(resolvedPrompt, [])
        }
      } else if (isSlashCommand && commandName) {
        // Execute slash command
        log.info("Executing slash command", { commandName, commandArgs })
        await executeCustomCommand(props.instanceId, props.sessionId, commandName, commandArgs)
      } else {
        await props.onSend(resolvedPrompt, currentAttachments)
      }
      void refreshHistory()
    } catch (error) {
      log.error("Failed to send message:", error)
      showAlertDialog("Failed to send message", {
        title: "Send failed",
        detail: error instanceof Error ? error.message : String(error),
        variant: "error",
      })
    } finally {
      textareaRef?.focus()
    }
  }

  function focusTextareaEnd() {
    if (!textareaRef) return
    setTimeout(() => {
      if (!textareaRef) return
      const pos = textareaRef.value.length
      textareaRef.setSelectionRange(pos, pos)
      textareaRef.focus()
    }, 0)
  }

  function canUseHistory(force = false, direction: "up" | "down" = "up") {
    if (force) return true
    if (showPicker()) return false
    const textarea = textareaRef
    if (!textarea) return false
    // For up arrow, require cursor at start
    // For down arrow, allow if we're already navigating history (historyIndex >= 0)
    if (direction === "down" && historyIndex() >= 0) return true
    return textarea.selectionStart === 0 && textarea.selectionEnd === 0
  }

  function selectPreviousHistory(force = false) {
    const entries = history()
    if (entries.length === 0) return false
    if (!canUseHistory(force)) return false

    if (historyIndex() === -1) {
      setHistoryDraft(prompt())
    }

    const newIndex = historyIndex() === -1 ? 0 : Math.min(historyIndex() + 1, entries.length - 1)
    setHistoryIndex(newIndex)
    setPrompt(entries[newIndex])
    focusTextareaEnd()
    return true
  }

  function selectNextHistory(force = false) {
    const entries = history()
    if (entries.length === 0) return false
    if (!canUseHistory(force, "down")) return false
    if (historyIndex() === -1) return false

    const newIndex = historyIndex() - 1
    if (newIndex >= 0) {
      setHistoryIndex(newIndex)
      setPrompt(entries[newIndex])
    } else {
      setHistoryIndex(-1)
      const draft = historyDraft()
      setPrompt(draft ?? "")
      setHistoryDraft(null)
    }
    focusTextareaEnd()
    return true
  }

  function handleAbort() {
    if (!props.onAbortSession || !props.isSessionBusy) return
    void props.onAbortSession()
  }

  function handleExpandToggle(nextState: "normal" | "expanded") {
    setExpandState(nextState)
    textareaRef?.focus()
  }

  function handleInput(e: Event) {

    const target = e.target as HTMLTextAreaElement
    const value = target.value
    setPrompt(value)
    setHistoryIndex(-1)
    setHistoryDraft(null)

    const isShellMode = mode() === "shell"

    // Detect "/" at start for slash commands (not in shell mode)
    if (!isShellMode && value.startsWith("/")) {
      const slashMatch = value.match(/^\/(\S*)/)
      if (slashMatch) {
        const query = slashMatch[1] || ""
        // Don't show picker if there's a space after the command (user is typing args)
        const hasSpaceAfterCommand = value.indexOf(" ") !== -1 && value.indexOf(" ") === slashMatch[0].length
        if (!hasSpaceAfterCommand || query.length === 0) {
          setSlashQuery(query)
          setShowSlashPicker(true)
          // Don't show @ picker while showing slash picker
          setShowPicker(false)
          setAtPosition(null)
          return
        }
      }
    }

    // Close slash picker if "/" is no longer at start
    if (showSlashPicker() && !value.startsWith("/")) {
      setShowSlashPicker(false)
      setSlashQuery("")
    }

    const cursorPos = target.selectionStart
    const textBeforeCursor = value.substring(0, cursorPos)
    const lastAtIndex = textBeforeCursor.lastIndexOf("@")

    const previousAtPosition = atPosition()

    if (lastAtIndex === -1) {
      setIgnoredAtPositions(new Set<number>())
    } else if (previousAtPosition !== null && lastAtIndex !== previousAtPosition) {
      setIgnoredAtPositions((prev) => {
        const next = new Set(prev)
        next.delete(previousAtPosition)
        return next
      })
    }

    if (lastAtIndex !== -1) {
      const textAfterAt = value.substring(lastAtIndex + 1, cursorPos)
      const hasSpace = textAfterAt.includes(" ") || textAfterAt.includes("\n")

      if (!hasSpace && cursorPos === lastAtIndex + textAfterAt.length + 1) {
        if (!ignoredAtPositions().has(lastAtIndex)) {
          setAtPosition(lastAtIndex)
          setSearchQuery(textAfterAt)
          setShowPicker(true)
          // Close slash picker when opening @ picker
          setShowSlashPicker(false)
          setSlashQuery("")
        }
        return
      }
    }

    setShowPicker(false)
    setAtPosition(null)
  }

  function handlePickerSelect(
    item:
      | { type: "agent"; agent: Agent }
      | {
          type: "file"
          file: { path: string; relativePath?: string; isGitFile: boolean; isDirectory?: boolean }
        },
  ) {
    if (item.type === "agent") {
      const agentName = item.agent.name
      const existingAttachments = attachments()
      const alreadyAttached = existingAttachments.some(
        (att) => att.source.type === "agent" && att.source.name === agentName,
      )

      if (!alreadyAttached) {
        const attachment = createAgentAttachment(agentName)
        addAttachment(props.instanceId, props.sessionId, attachment)
      }

      const currentPrompt = prompt()
      const pos = atPosition()
      const cursorPos = textareaRef?.selectionStart || 0

      if (pos !== null) {
        const before = currentPrompt.substring(0, pos)
        const after = currentPrompt.substring(cursorPos)
        const attachmentText = `@${agentName}`
        const newPrompt = before + attachmentText + " " + after
        setPrompt(newPrompt)

        setTimeout(() => {
          if (textareaRef) {
            const newCursorPos = pos + attachmentText.length + 1
            textareaRef.setSelectionRange(newCursorPos, newCursorPos)
          }
        }, 0)
      }
    } else if (item.type === "file") {
      const displayPath = item.file.path
      const relativePath = item.file.relativePath ?? displayPath
      const isFolder = item.file.isDirectory ?? displayPath.endsWith("/")

      if (isFolder) {
        const currentPrompt = prompt()
        const pos = atPosition()
        const cursorPos = textareaRef?.selectionStart || 0
        const folderMention =
          relativePath === "." || relativePath === ""
            ? "/"
            : relativePath.replace(/\/+$/, "") + "/"

        if (pos !== null) {
          const before = currentPrompt.substring(0, pos + 1)
          const after = currentPrompt.substring(cursorPos)
          const newPrompt = before + folderMention + after
          setPrompt(newPrompt)
          setSearchQuery(folderMention)

          setTimeout(() => {
            if (textareaRef) {
              const newCursorPos = pos + 1 + folderMention.length
              textareaRef.setSelectionRange(newCursorPos, newCursorPos)
            }
          }, 0)
        }

        return
      }

      const normalizedPath = relativePath.replace(/\/+$/, "") || relativePath
      const pathSegments = normalizedPath.split("/")
      const filename = (() => {
        const candidate = pathSegments[pathSegments.length - 1] || normalizedPath
        return candidate === "." ? "/" : candidate
      })()

      const existingAttachments = attachments()
      const alreadyAttached = existingAttachments.some(
        (att) => att.source.type === "file" && att.source.path === normalizedPath,
      )

      if (!alreadyAttached) {
        const attachment = createFileAttachment(normalizedPath, filename, "text/plain", undefined, props.instanceFolder)
        addAttachment(props.instanceId, props.sessionId, attachment)
      }

      const currentPrompt = prompt()
      const pos = atPosition()
      const cursorPos = textareaRef?.selectionStart || 0

      if (pos !== null) {
        const before = currentPrompt.substring(0, pos)
        const after = currentPrompt.substring(cursorPos)
        const attachmentText = `@${normalizedPath}`
        const newPrompt = before + attachmentText + " " + after
        setPrompt(newPrompt)

        setTimeout(() => {
          if (textareaRef) {
            const newCursorPos = pos + attachmentText.length + 1
            textareaRef.setSelectionRange(newCursorPos, newCursorPos)
          }
        }, 0)
      }
    }

    setShowPicker(false)
    setAtPosition(null)
    setSearchQuery("")
    textareaRef?.focus()
  }

  function handlePickerClose() {
    const pos = atPosition()
    if (pos !== null) {
      setIgnoredAtPositions((prev) => new Set(prev).add(pos))
    }
    setShowPicker(false)
    setAtPosition(null)
    setSearchQuery("")
    setTimeout(() => textareaRef?.focus(), 0)
  }

  function handleSlashPickerClose() {
    setShowSlashPicker(false)
    setSlashQuery("")
    setTimeout(() => textareaRef?.focus(), 0)
  }

  async function handleSlashCommandSelect(command: SDKCommand) {
    const currentText = prompt()
    // Extract any arguments after the command name
    const slashMatch = currentText.match(/^\/(\S*)\s*(.*)$/)
    const args = slashMatch?.[2]?.trim() || ""

    setShowSlashPicker(false)
    setSlashQuery("")

    // Replace the prompt with just the command (user can add args)
    const newPrompt = `/${command.name} `
    setPrompt(newPrompt)

    setTimeout(() => {
      if (textareaRef) {
        const pos = newPrompt.length
        textareaRef.setSelectionRange(pos, pos)
        textareaRef.focus()
      }
    }, 0)
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }

  function handleDragLeave(e: DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    const files = e.dataTransfer?.files
    if (!files || files.length === 0) return

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const path = (file as File & { path?: string }).path || file.name
      const filename = file.name
      const mime = file.type || "text/plain"

      const createAndStoreAttachment = (previewUrl?: string) => {
        const attachment = createFileAttachment(path, filename, mime, undefined, props.instanceFolder)
        if (previewUrl && (mime.startsWith("image/") || mime.startsWith("text/"))) {
          attachment.url = previewUrl
        }
        addAttachment(props.instanceId, props.sessionId, attachment)
      }

      if (mime.startsWith("image/") && typeof FileReader !== "undefined") {
        const reader = new FileReader()
        reader.onload = () => {
          const result = typeof reader.result === "string" ? reader.result : undefined
          createAndStoreAttachment(result)
        }
        reader.readAsDataURL(file)
      } else if (mime.startsWith("text/") && typeof FileReader !== "undefined") {
        const reader = new FileReader()
        reader.onload = () => {
          const dataUrl = typeof reader.result === "string" ? reader.result : undefined
          createAndStoreAttachment(dataUrl)
        }
        reader.readAsDataURL(file)
      } else {
        createAndStoreAttachment()
      }
    }

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
    setHistoryIndex(-1)
    setHistoryDraft(null)
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

  const shellHint = () => (mode() === "shell" ? { key: "Esc", text: "to exit shell mode" } : { key: "!", text: "for shell mode" })

  const shouldShowOverlay = () => prompt().length === 0

  const instance = () => getActiveInstance()

  // Show read-only footer for sub-agent sessions
  if (props.isSubAgentSession) {
    return (
      <div class="flex flex-col border-t border-border bg-background">
        <div class="flex items-center justify-between gap-4 px-4 py-3 bg-secondary border-t border-border">
          <div class="flex items-center gap-2">
            <span class="text-lg">🤖</span>
            <span class="text-sm text-muted-foreground">
              This is a sub-agent session. You cannot send messages to sub-agents directly.
            </span>
          </div>
          <Show when={props.onReturnToParent}>
            <button
              class="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors bg-info text-primary-foreground hover:brightness-110 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-info"
              onClick={props.onReturnToParent}
              title={`Return to ${props.parentSessionTitle || "parent session"}`}
            >
              <ArrowLeft class="w-4 h-4" />
              <span>Return to {props.parentSessionTitle || "parent"}</span>
            </button>
          </Show>
        </div>
      </div>
    )
  }

  return (
    <div class="flex flex-col border-t border-border bg-background">
      <div
        ref={containerRef}
        class={cn(
          "grid items-stretch relative",
          isDragging() && "border-2 border-info bg-info/5",
          props.hasActiveQuestion && "animate-question-glow"
        )}
        style={{ "grid-template-columns": "minmax(0, 1fr) 64px" }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <Show when={showPicker() && instance()}>
          <UnifiedPicker
            open={showPicker()}
            onClose={handlePickerClose}
            onSelect={handlePickerSelect}
            agents={instanceAgents()}
            instanceClient={instance()!.client}
            searchQuery={searchQuery()}
            textareaRef={textareaRef}
            workspaceId={props.instanceId}
          />
        </Show>

        <Show when={showSlashPicker()}>
          <SlashCommandPicker
            open={showSlashPicker()}
            onClose={handleSlashPickerClose}
            onSelect={handleSlashCommandSelect}
            searchQuery={slashQuery()}
            instanceId={props.instanceId}
            textareaRef={textareaRef}
          />
        </Show>

        <div class="flex flex-1 flex-col">
          <Show when={attachments().length > 0}>
            <div class="flex flex-wrap gap-1.5 border-b border-border pb-2">
              <For each={attachments()}>
                {(attachment) => {
                  const isImage = attachment.mediaType.startsWith("image/")
                  const textValue = attachment.source.type === "text" ? attachment.source.value : undefined
                  const isTextAttachment = typeof textValue === "string"
                  return (
                    <div
                      class={cn(
                        "inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium ring-1 ring-inset bg-info/10 text-info ring-info/10 rounded-md",
                        isImage && "relative"
                      )}
                      title={textValue}
                    >
                      <Show
                        when={isImage}
                        fallback={
                          <Show
                            when={isTextAttachment}
                            fallback={
                              <Show
                                when={attachment.source.type === "agent"}
                                fallback={
                                  <svg class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path
                                      stroke-linecap="round"
                                      stroke-linejoin="round"
                                      stroke-width="2"
                                      d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                                    />
                                  </svg>
                                }
                              >
                                <svg class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path
                                    stroke-linecap="round"
                                    stroke-linejoin="round"
                                    stroke-width="2"
                                    d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                                  />
                                </svg>
                              </Show>
                            }
                          >
                            <svg class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2"
                                d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                              />
                            </svg>
                          </Show>
                        }
                      >
                        <img src={attachment.url} alt={attachment.filename} class="h-5 w-5 rounded object-cover" />
                      </Show>
                      <span>{isTextAttachment ? attachment.display : attachment.filename}</span>
                      <Show when={isTextAttachment}>
                        <button
                          onClick={() => handleExpandTextAttachment(attachment)}
                          class="ml-0.5 flex h-4 w-4 items-center justify-center rounded transition-colors hover:bg-info/10"
                          aria-label="Expand pasted text"
                          title="Insert pasted text"
                        >
                          <svg class="h-3 w-3" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M7 7h6v6H7z" />
                            <path stroke-linecap="round" stroke-linejoin="round" d="M4 4h12v12" />
                          </svg>
                        </button>
                      </Show>
                      <button
                        onClick={() => handleRemoveAttachment(attachment.id)}
                        class="ml-0.5 flex h-4 w-4 items-center justify-center rounded transition-colors hover:bg-info/10"
                        aria-label="Remove attachment"
                      >
                        <svg class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M6 18L18 6M6 6l12 12"
                          />
                        </svg>
                      </button>
                      <Show when={isImage}>
                        <div class="hidden absolute bottom-[calc(100%+6px)] left-0 p-2 bg-background border border-border rounded-[10px] shadow-[0_16px_40px_rgba(15,23,42,0.25)] z-20 group-hover:block peer-hover:block [.relative:hover_&]:block">
                          <img src={attachment.url} alt={attachment.filename} class="block max-w-[320px] max-h-[320px] rounded-lg object-contain" />
                        </div>
                      </Show>
                    </div>
                  )
                }}
              </For>
            </div>
          </Show>
          <div class={cn(
            "relative w-full min-h-[56px] flex-1 h-full min-w-0",
            expandState() === "expanded" && "h-auto"
          )}>
            <div class={cn(
              "relative w-full h-full",
              expandState() === "expanded" && "h-auto"
            )}>
              <textarea
                ref={textareaRef}
                class={cn(
                  "w-full pl-3 pr-10 pt-2.5 border text-sm resize-none outline-none transition-colors bg-background text-foreground border-border rounded-none pb-0 h-full min-h-full font-[inherit] leading-normal",
                  mode() === "shell" && "border-success shadow-[inset_0_0_0_1px_hsl(var(--success)/0.4)]",
                  expandState() === "expanded" && "h-auto min-h-0 overflow-y-auto",
                  "focus:border-info focus:shadow-none",
                  mode() === "shell" && "focus:border-success focus:shadow-[inset_0_0_0_1px_hsl(var(--success)/0.4)]",
                  "placeholder:text-muted-foreground disabled:opacity-60 disabled:cursor-not-allowed"
                )}
                placeholder={
                  mode() === "shell"
                    ? "Run a shell command (Esc to exit)..."
                    : props.hasActiveQuestion
                      ? "Type your answer here..."
                      : "Type your message, @file, @agent, or paste images and text..."
                }
                value={prompt()}
                onInput={handleInput}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onFocus={() => setIsFocused(true)}
                onBlur={() => setIsFocused(false)}
                disabled={props.disabled}
                rows={expandState() === "expanded" ? 15 : 4}
                style={attachments().length > 0 ? { "padding-top": "8px" } : {}}
                spellcheck={false}
                autocorrect="off"
                autoCapitalize="off"
                autocomplete="off"
              />
              <div class="absolute top-1 right-1 bottom-1 flex flex-col justify-start gap-0.5 z-[2]">
                <ExpandButton
                  expandState={expandState}
                  onToggleExpand={handleExpandToggle}
                />
                <Show when={hasHistory()}>
                  <Button
                    variant="ghost"
                    size="icon"
                    type="button"
                    class="w-7 h-7 flex-shrink-0 text-muted-foreground bg-black/[0.04] hover:bg-secondary hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
                    onClick={() => selectPreviousHistory(true)}
                    disabled={!canHistoryGoPrevious()}
                    aria-label="Previous prompt"
                  >
                    <ArrowBigUp class="h-5 w-5" aria-hidden="true" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    type="button"
                    class="w-7 h-7 flex-shrink-0 text-muted-foreground bg-black/[0.04] hover:bg-secondary hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
                    onClick={() => selectNextHistory(true)}
                    disabled={!canHistoryGoNext()}
                    aria-label="Next prompt"
                  >
                    <ArrowBigDown class="h-5 w-5" aria-hidden="true" />
                  </Button>
                </Show>
              </div>
            <Show when={shouldShowOverlay()}>
              <div class={cn(
                "absolute bottom-4 left-3 right-3 flex flex-wrap gap-2 text-xs leading-tight text-muted-foreground pointer-events-none z-[1]",
                mode() === "shell" && "text-foreground"
              )}>
                <Show
                  when={props.escapeInDebounce}
                  fallback={
                    <>
                      <Show when={attachments().length > 0}>
                        <span class="inline-flex items-center gap-[0.35rem] text-muted-foreground">{attachments().length} file(s) attached</span>
                      </Show>
                      <Show when={mode() === "shell"}>
                        <span class="text-success font-semibold">Shell mode active</span>
                      </Show>
                    </>
                  }
                >
                  <>
                    <span class="inline-flex items-center gap-[0.35rem] text-warning font-medium">
                      Press <Kbd>Esc</Kbd> again to abort session
                    </span>
                    <Show when={mode() === "shell"}>
                      <span class="text-success font-semibold">Shell mode active</span>
                    </Show>
                  </>
                </Show>
              </div>
            </Show>
          </div>
        </div>
      </div>

        <div class="flex flex-col items-center self-stretch h-full px-1 py-2 gap-2">
          <Button
            variant="ghost"
            size="icon"
            type="button"
            class={cn(
              "w-9 h-9 rounded-lg cursor-pointer flex-shrink-0 transition-all",
              "bg-secondary text-destructive border border-border",
              "hover:bg-destructive/10 hover:border-destructive",
              "active:scale-95",
              !canStop() && "opacity-30 cursor-not-allowed text-muted-foreground"
            )}
            onClick={handleAbort}
            disabled={!canStop()}
            aria-label="Stop session"
            title="Stop session"
          >
            <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <rect x="4" y="4" width="12" height="12" rx="2" />
            </svg>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            type="button"
            class={cn(
              "w-9 h-9 rounded-lg cursor-pointer flex-shrink-0 transition-all mt-auto",
              mode() === "shell"
                ? "bg-success text-primary-foreground border border-success hover:brightness-110 active:brightness-95"
                : "bg-info text-primary-foreground border border-info hover:brightness-110",
              "active:scale-95",
              "disabled:opacity-30 disabled:cursor-not-allowed disabled:bg-secondary disabled:border-border disabled:text-muted-foreground"
            )}
            onClick={handleSend}
            disabled={!canSend()}
            aria-label="Send message"
          >
            <Show
              when={mode() === "shell"}
              fallback={<span class="text-sm">▶</span>}
            >
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M5 8l5 4-5 4" />
                <path stroke-linecap="round" stroke-linejoin="round" d="M13 16h6" />
              </svg>
            </Show>
          </Button>
        </div>
      </div>
    </div>
  )
}
