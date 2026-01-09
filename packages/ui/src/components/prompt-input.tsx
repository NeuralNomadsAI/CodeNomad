import { createSignal, Show, onMount, For, onCleanup, createEffect, on, untrack } from "solid-js"
import { ArrowBigUp, ArrowBigDown } from "lucide-solid"
import UnifiedPicker from "./unified-picker"
import { addToHistory, getHistory } from "../stores/message-history"
import { getAttachments, addAttachment, clearAttachments, removeAttachment } from "../stores/attachments"
import { resolvePastedPlaceholders } from "../lib/prompt-placeholders"
import { createFileAttachment, createTextAttachment, createAgentAttachment } from "../types/attachment"
import type { Attachment } from "../types/attachment"
import type { Agent } from "../types/session"
import type { Command as SDKCommand } from "@opencode-ai/sdk/v2"
import Kbd from "./kbd"
import { getActiveInstance } from "../stores/instances"
import { agents, getSessionDraftPrompt, setSessionDraftPrompt, clearSessionDraftPrompt, executeCustomCommand } from "../stores/sessions"
import { getCommands } from "../stores/commands"
import { showAlertDialog } from "../stores/alerts"
import { getLogger } from "../lib/logger"
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
}

export default function PromptInput(props: PromptInputProps) {
  const [prompt, setPromptInternal] = createSignal("")
  const [history, setHistory] = createSignal<string[]>([])
  const HISTORY_LIMIT = 100
  const [historyIndex, setHistoryIndex] = createSignal(-1)
  const [historyDraft, setHistoryDraft] = createSignal<string | null>(null)
  const [, setIsFocused] = createSignal(false)
  const [showPicker, setShowPicker] = createSignal(false)
  const [pickerMode, setPickerMode] = createSignal<"mention" | "command">("mention")
  const [searchQuery, setSearchQuery] = createSignal("")
  const [atPosition, setAtPosition] = createSignal<number | null>(null)
  const [isDragging, setIsDragging] = createSignal(false)
  const [ignoredAtPositions, setIgnoredAtPositions] = createSignal<Set<number>>(new Set<number>())
  const [pasteCount, setPasteCount] = createSignal(0)
  const [imageCount, setImageCount] = createSignal(0)
  const [mode, setMode] = createSignal<"normal" | "shell">("normal")
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

    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      if (showPicker()) {
        handlePickerClose()
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

    const resolvedPrompt = isKnownSlashCommand ? text : resolvePastedPlaceholders(text, currentAttachments)
    const historyEntry = resolvedPrompt

    const refreshHistory = async () => {
      try {
        await addToHistory(props.instanceFolder, historyEntry)
        setHistory((prev) => {
          const next = [historyEntry, ...prev]
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

    clearPrompt()

    // Ignore attachments for slash commands, but keep them for next prompt.
    if (!isKnownSlashCommand) {
      clearAttachments(props.instanceId, props.sessionId)
      setPasteCount(0)
      setImageCount(0)
      setIgnoredAtPositions(new Set<number>())
    } else {
      syncAttachmentCounters("", currentAttachments)
      setIgnoredAtPositions(new Set<number>())
    }

    setHistoryDraft(null)

    if (isKnownSlashCommand) {
      // Record attempted slash commands even if execution fails.
      void refreshHistory()
    }
 
    try {
      if (isShellMode) {
        if (props.onRunShell) {
          await props.onRunShell(resolvedPrompt)
        } else {
          await props.onSend(resolvedPrompt, [])
        }
      } else if (isKnownSlashCommand) {
        await executeCustomCommand(props.instanceId, props.sessionId, commandName, commandArgs)
      } else {
        await props.onSend(resolvedPrompt, currentAttachments)
      }
      if (!isKnownSlashCommand) {
        void refreshHistory()
      }
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
 
  function canUseHistory(force = false) {
    if (force) return true
    if (showPicker()) return false
    const textarea = textareaRef
    if (!textarea) return false
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
    if (!canUseHistory(force)) return false
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
 
  function handleInput(e: Event) {

    const target = e.target as HTMLTextAreaElement
    const value = target.value
    setPrompt(value)
    setHistoryIndex(-1)
    setHistoryDraft(null)

    const cursorPos = target.selectionStart

    // Slash command picker (only when editing the command token: "/<query>")
    if (value.startsWith("/") && cursorPos >= 1) {
      const firstWhitespaceIndex = value.slice(1).search(/\s/)
      const tokenEnd = firstWhitespaceIndex === -1 ? value.length : firstWhitespaceIndex + 1

      if (cursorPos <= tokenEnd) {
        setPickerMode("command")
        setAtPosition(0)
        setSearchQuery(value.substring(1, cursorPos))
        setShowPicker(true)
        return
      }
    }

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
          setPickerMode("mention")
          setAtPosition(lastAtIndex)
          setSearchQuery(textAfterAt)
          setShowPicker(true)
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
        }
      | { type: "command"; command: SDKCommand },
  ) {
    if (item.type === "command") {
      const name = item.command.name
      const currentPrompt = prompt()

      const afterSlash = currentPrompt.slice(1)
      const firstWhitespaceIndex = afterSlash.search(/\s/)
      const tokenEnd = firstWhitespaceIndex === -1 ? currentPrompt.length : firstWhitespaceIndex + 1

      const before = ""
      const after = currentPrompt.substring(tokenEnd)
      const newPrompt = before + `/${name} ` + after
      setPrompt(newPrompt)

      setTimeout(() => {
        if (textareaRef) {
          const newCursorPos = `/${name} `.length
          textareaRef.setSelectionRange(newCursorPos, newCursorPos)
          textareaRef.focus()
        }
      }, 0)
    } else if (item.type === "agent") {
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
        const folderMention = relativePath === "." || relativePath === "" ? "/" : displayPath

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
        const attachmentText = `@${filename}`
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
    if (pickerMode() === "mention" && pos !== null) {
      setIgnoredAtPositions((prev) => new Set(prev).add(pos))
    }
    setShowPicker(false)
    setAtPosition(null)
    setSearchQuery("")
    setTimeout(() => textareaRef?.focus(), 0)
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
 
  const shellHint = () => (mode() === "shell" ? { key: "Esc", text: "to exit shell mode" } : { key: "!", text: "Shell mode" })
  const commandHint = () => ({ key: "/", text: "Commands" })

  const shouldShowOverlay = () => prompt().length === 0

  const instance = () => getActiveInstance()

  return (
    <div class="prompt-input-container">
      <div
        ref={containerRef}
        class={`prompt-input-wrapper relative ${isDragging() ? "border-2" : ""}`}
        style={
          isDragging()
            ? "border-color: var(--accent-primary); background-color: rgba(0, 102, 255, 0.05);"
            : ""
        }
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <Show when={showPicker() && instance()}>
          <UnifiedPicker
            open={showPicker()}
            mode={pickerMode()}
            onClose={handlePickerClose}
            onSelect={handlePickerSelect}
            agents={instanceAgents()}
            commands={getCommands(props.instanceId)}
            instanceClient={instance()!.client}
            searchQuery={searchQuery()}
            textareaRef={textareaRef}
            workspaceId={props.instanceId}
          />
        </Show>

        <div class="flex flex-1 flex-col">
          <Show when={attachments().length > 0}>
            <div class="flex flex-wrap gap-1.5 border-b pb-2" style="border-color: var(--border-base);">
              <For each={attachments()}>
                {(attachment) => {
                  const isImage = attachment.mediaType.startsWith("image/")
                  const textValue = attachment.source.type === "text" ? attachment.source.value : undefined
                  const isTextAttachment = typeof textValue === "string"
                  return (
                    <div
                      class={`attachment-chip ${isImage ? "attachment-chip-image" : ""}`}
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
                          class="attachment-expand"
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
                        class="attachment-remove"
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
                        <div class="attachment-chip-preview">
                          <img src={attachment.url} alt={attachment.filename} />
                        </div>
                      </Show>
                    </div>
                  )
                }}
              </For>
            </div>
          </Show>
          <div class="prompt-input-field-container">
            <div class="prompt-input-field">
              <textarea
              ref={textareaRef}
              class={`prompt-input ${mode() === "shell" ? "shell-mode" : ""}`}
              placeholder={
                mode() === "shell"
                  ? "Run a shell command (Esc to exit)..."
                  : "Type your message, @file, @agent, or paste images and text..."
              }
              value={prompt()}
              onInput={handleInput}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              disabled={props.disabled}
              rows={4}
              style={attachments().length > 0 ? { "padding-top": "8px" } : {}}
              spellcheck={false}
              autocorrect="off"
              autoCapitalize="off"
              autocomplete="off"
            />
            <Show when={hasHistory()}>
              <div class="prompt-history-top">
                <button
                  type="button"
                  class="prompt-history-button"
                  onClick={() => selectPreviousHistory(true)}
                  disabled={!canHistoryGoPrevious()}
                  aria-label="Previous prompt"
                >
                  <ArrowBigUp class="h-5 w-5" aria-hidden="true" />
                </button>
              </div>
              <div class="prompt-history-bottom">
                <button
                  type="button"
                  class="prompt-history-button"
                  onClick={() => selectNextHistory(true)}
                  disabled={!canHistoryGoNext()}
                  aria-label="Next prompt"
                >
                  <ArrowBigDown class="h-5 w-5" aria-hidden="true" />
                </button>
              </div>
            </Show>
            <Show when={shouldShowOverlay()}>
              <div class={`prompt-input-overlay ${mode() === "shell" ? "shell-mode" : ""}`}>
                <Show
                  when={props.escapeInDebounce}
                  fallback={
                    <>
                      <span class="prompt-overlay-text">
                        <Kbd>Enter</Kbd> New line • <Kbd shortcut="cmd+enter" /> Send • <Kbd>@</Kbd> Files/agents • <Kbd>↑↓</Kbd> History
                      </span>
                      <Show when={attachments().length > 0}>
                        <span class="prompt-overlay-text prompt-overlay-muted">• {attachments().length} file(s) attached</span>
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
                        <span class="prompt-overlay-shell-active">Shell mode active</span>
                      </Show>
                    </>
                  }
                >
                  <>
                    <span class="prompt-overlay-text prompt-overlay-warning">
                      Press <Kbd>Esc</Kbd> again to abort session
                    </span>
                    <Show when={mode() === "shell"}>
                      <span class="prompt-overlay-shell-active">Shell mode active</span>
                    </Show>
                  </>
                </Show>
              </div>
            </Show>
          </div>
        </div>
      </div>

        <div class="prompt-input-actions">
          <button
            type="button"
            class="stop-button"
            onClick={handleAbort}
            disabled={!canStop()}
            aria-label="Stop session"
            title="Stop session"
          >
            <svg class="stop-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <rect x="4" y="4" width="12" height="12" rx="2" />
            </svg>
          </button>
          <button
            type="button"
            class={`send-button ${mode() === "shell" ? "shell-mode" : ""}`}
            onClick={handleSend}
            disabled={!canSend()}
            aria-label="Send message"
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
    </div>
  )
}
