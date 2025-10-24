import { createSignal, Show, onMount, For, onCleanup } from "solid-js"
import AgentSelector from "./agent-selector"
import ModelSelector from "./model-selector"
import UnifiedPicker from "./unified-picker"
import { addToHistory, getHistory } from "../stores/message-history"
import { getAttachments, addAttachment, clearAttachments, removeAttachment } from "../stores/attachments"
import { createFileAttachment, createTextAttachment, createAgentAttachment } from "../types/attachment"
import type { Attachment } from "../types/attachment"
import Kbd from "./kbd"
import HintRow from "./hint-row"
import { getActiveInstance } from "../stores/instances"
import { agents } from "../stores/sessions"

interface PromptInputProps {
  instanceId: string
  instanceFolder: string
  sessionId: string
  onSend: (prompt: string, attachments: Attachment[]) => Promise<void>
  disabled?: boolean
  agent: string
  model: { providerId: string; modelId: string }
  onAgentChange: (agent: string) => Promise<void>
  onModelChange: (model: { providerId: string; modelId: string }) => Promise<void>
  escapeInDebounce?: boolean
}

export default function PromptInput(props: PromptInputProps) {
  const [prompt, setPrompt] = createSignal("")
  const [sending, setSending] = createSignal(false)
  const [history, setHistory] = createSignal<string[]>([])
  const [historyIndex, setHistoryIndex] = createSignal(-1)
  const [isFocused, setIsFocused] = createSignal(false)
  const [showPicker, setShowPicker] = createSignal(false)
  const [searchQuery, setSearchQuery] = createSignal("")
  const [atPosition, setAtPosition] = createSignal<number | null>(null)
  const [isDragging, setIsDragging] = createSignal(false)
  const [ignoredAtPositions, setIgnoredAtPositions] = createSignal<Set<number>>(new Set())
  const [pasteCount, setPasteCount] = createSignal(0)
  const [imageCount, setImageCount] = createSignal(0)
  let textareaRef: HTMLTextAreaElement | undefined
  let containerRef: HTMLDivElement | undefined

  const attachments = () => getAttachments(props.instanceId, props.sessionId)
  const instanceAgents = () => agents().get(props.instanceId) || []

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

      if (textareaRef) {
        textareaRef.style.height = "auto"
        textareaRef.style.height = Math.min(textareaRef.scrollHeight, 200) + "px"
      }
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
              textarea.style.height = "auto"
              textarea.style.height = Math.min(textarea.scrollHeight, 200) + "px"
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
          textarea.style.height = "auto"
          textarea.style.height = Math.min(textarea.scrollHeight, 200) + "px"
          textarea.focus()
        }, 0)
      }
    }
  }

  onMount(async () => {
    const loaded = await getHistory(props.instanceFolder)
    setHistory(loaded)

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
  })

  function handleKeyDown(e: KeyboardEvent) {
    const textarea = textareaRef
    if (!textarea) return

    if (e.key === "Backspace" || e.key === "Delete") {
      const cursorPos = textarea.selectionStart
      const text = prompt()

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
            textarea.style.height = "auto"
            textarea.style.height = Math.min(textarea.scrollHeight, 200) + "px"
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
            textarea.style.height = "auto"
            textarea.style.height = Math.min(textarea.scrollHeight, 200) + "px"
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
              textarea.style.height = "auto"
              textarea.style.height = Math.min(textarea.scrollHeight, 200) + "px"
            }, 0)

            return
          }
        }
      }
    }

    if (e.key === "Enter" && !e.shiftKey && !showPicker()) {
      e.preventDefault()
      handleSend()
      return
    }

    const atStart = textarea.selectionStart === 0 && textarea.selectionEnd === 0
    const currentHistory = history()

    if (e.key === "ArrowUp" && !showPicker() && atStart && currentHistory.length > 0) {
      e.preventDefault()
      const newIndex = historyIndex() === -1 ? 0 : Math.min(historyIndex() + 1, currentHistory.length - 1)
      setHistoryIndex(newIndex)
      setPrompt(currentHistory[newIndex])
      setTimeout(() => {
        textarea.style.height = "auto"
        textarea.style.height = Math.min(textarea.scrollHeight, 200) + "px"
      }, 0)
      return
    }

    if (e.key === "ArrowDown" && !showPicker() && historyIndex() >= 0) {
      e.preventDefault()
      const newIndex = historyIndex() - 1
      if (newIndex >= 0) {
        setHistoryIndex(newIndex)
        setPrompt(currentHistory[newIndex])
      } else {
        setHistoryIndex(-1)
        setPrompt("")
      }
      setTimeout(() => {
        textarea.style.height = "auto"
        textarea.style.height = Math.min(textarea.scrollHeight, 200) + "px"
      }, 0)
      return
    }
  }

  async function handleSend() {
    const text = prompt().trim()
    const currentAttachments = attachments()
    if (!text || sending() || props.disabled) return

    setSending(true)
    try {
      await addToHistory(props.instanceFolder, text)

      const updated = await getHistory(props.instanceFolder)
      setHistory(updated)
      setHistoryIndex(-1)

      await props.onSend(text, currentAttachments)
      setPrompt("")
      clearAttachments(props.instanceId, props.sessionId)
      setIgnoredAtPositions(new Set<number>())
      setPasteCount(0)
      setImageCount(0)

      if (textareaRef) {
        textareaRef.style.height = "auto"
      }
    } catch (error) {
      console.error("Failed to send message:", error)
      alert("Failed to send message: " + (error instanceof Error ? error.message : String(error)))
    } finally {
      setSending(false)
      textareaRef?.focus()
    }
  }

  function handleInput(e: Event) {
    const target = e.target as HTMLTextAreaElement
    const value = target.value
    setPrompt(value)
    setHistoryIndex(-1)

    target.style.height = "auto"
    target.style.height = Math.min(target.scrollHeight, 200) + "px"

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
        }
        return
      }
    }

    setShowPicker(false)
    setAtPosition(null)
  }

  function handlePickerSelect(item: { type: "agent"; agent: any } | { type: "file"; file: any }) {
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
            textareaRef.style.height = "auto"
            textareaRef.style.height = Math.min(textareaRef.scrollHeight, 200) + "px"
          }
        }, 0)
      }
    } else if (item.type === "file") {
      const path = item.file.path
      const isFolder = path.endsWith("/")
      const filename = path.split("/").pop() || path

      if (isFolder) {
        const currentPrompt = prompt()
        const pos = atPosition()
        const cursorPos = textareaRef?.selectionStart || 0

        if (pos !== null) {
          const before = currentPrompt.substring(0, pos + 1)
          const after = currentPrompt.substring(cursorPos)
          const newPrompt = before + path + after
          setPrompt(newPrompt)
          setSearchQuery(path)

          setTimeout(() => {
            if (textareaRef) {
              const newCursorPos = pos + 1 + path.length
              textareaRef.setSelectionRange(newCursorPos, newCursorPos)
              textareaRef.style.height = "auto"
              textareaRef.style.height = Math.min(textareaRef.scrollHeight, 200) + "px"
              textareaRef.focus()
            }
          }, 0)
        }

        return
      }

      const existingAttachments = attachments()
      const alreadyAttached = existingAttachments.some((att) => att.source.type === "file" && att.source.path === path)

      if (!alreadyAttached) {
        const attachment = createFileAttachment(path, filename, "text/plain", undefined, props.instanceFolder)
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
            textareaRef.style.height = "auto"
            textareaRef.style.height = Math.min(textareaRef.scrollHeight, 200) + "px"
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
      const path = (file as any).path || file.name
      const filename = file.name
      const mime = file.type || "text/plain"

      const attachment = createFileAttachment(path, filename, mime, undefined, props.instanceFolder)
      addAttachment(props.instanceId, props.sessionId, attachment)
    }

    textareaRef?.focus()
  }

  const canSend = () => (prompt().trim().length > 0 || attachments().length > 0) && !sending() && !props.disabled

  const instance = () => getActiveInstance()

  return (
    <div class="prompt-input-container">
      <div
        ref={containerRef}
        class={`prompt-input-wrapper relative ${isDragging() ? "border-2 border-blue-500 bg-blue-50 dark:bg-blue-900/10" : ""}`}
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
            workspaceFolder={props.instanceFolder}
          />
        </Show>

        <div class="flex flex-1 flex-col">
          <Show when={attachments().length > 0}>
            <div class="flex flex-wrap gap-1.5 border-b border-gray-200 pb-2 dark:border-gray-700">
              <For each={attachments()}>
                {(attachment) => {
                  const isImage = attachment.mediaType.startsWith("image/")
                  return (
                    <div class="inline-flex items-center gap-1.5 rounded-md bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700 ring-1 ring-inset ring-blue-700/10 dark:bg-blue-500/10 dark:text-blue-400 dark:ring-blue-500/20">
                      <Show
                        when={isImage}
                        fallback={
                          <Show
                            when={attachment.source.type === "text"}
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
                      <span>{attachment.source.type === "text" ? attachment.display : attachment.filename}</span>
                      <button
                        onClick={() => handleRemoveAttachment(attachment.id)}
                        class="ml-0.5 flex h-4 w-4 items-center justify-center rounded hover:bg-blue-100 dark:hover:bg-blue-500/20"
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
                    </div>
                  )
                }}
              </For>
            </div>
          </Show>
          <textarea
            ref={textareaRef}
            class="prompt-input"
            placeholder="Type your message, @file, @agent, or /command..."
            value={prompt()}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            disabled={sending() || props.disabled}
            rows={1}
            style={attachments().length > 0 ? { "padding-top": "8px" } : {}}
          />
        </div>

        <button class="send-button" onClick={handleSend} disabled={!canSend()} aria-label="Send message">
          <Show when={sending()} fallback={<span class="send-icon">▶</span>}>
            <span class="spinner-small" />
          </Show>
        </button>
      </div>
      <div class="prompt-input-hints">
        <HintRow>
          <Show
            when={props.escapeInDebounce}
            fallback={
              <>
                <Kbd>Enter</Kbd> to send • <Kbd>Shift+Enter</Kbd> for new line • <Kbd>@</Kbd> for files/agents •{" "}
                <Kbd>↑↓</Kbd> for history
                <Show when={attachments().length > 0}>
                  <span class="ml-2 text-xs text-gray-500">• {attachments().length} file(s) attached</span>
                </Show>
              </>
            }
          >
            <span class="text-orange-600 dark:text-orange-400 font-medium">
              Press <Kbd>Esc</Kbd> again to abort session
            </span>
          </Show>
        </HintRow>
        <div class="flex items-center gap-2">
          <AgentSelector
            instanceId={props.instanceId}
            sessionId={props.sessionId}
            currentAgent={props.agent}
            onAgentChange={props.onAgentChange}
          />
          <ModelSelector
            instanceId={props.instanceId}
            sessionId={props.sessionId}
            currentModel={props.model}
            onModelChange={props.onModelChange}
          />
        </div>
      </div>
    </div>
  )
}
