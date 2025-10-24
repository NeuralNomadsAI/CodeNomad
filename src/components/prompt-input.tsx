import { createSignal, Show, onMount, For } from "solid-js"
import AgentSelector from "./agent-selector"
import ModelSelector from "./model-selector"
import FilePicker from "./file-picker"
import { addToHistory, getHistory } from "../stores/message-history"
import { getAttachments, addAttachment, clearAttachments, removeAttachment } from "../stores/attachments"
import { createFileAttachment } from "../types/attachment"
import type { Attachment } from "../types/attachment"
import Kbd from "./kbd"
import HintRow from "./hint-row"
import { getActiveInstance } from "../stores/instances"

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
}

export default function PromptInput(props: PromptInputProps) {
  const [prompt, setPrompt] = createSignal("")
  const [sending, setSending] = createSignal(false)
  const [history, setHistory] = createSignal<string[]>([])
  const [historyIndex, setHistoryIndex] = createSignal(-1)
  const [isFocused, setIsFocused] = createSignal(false)
  const [showFilePicker, setShowFilePicker] = createSignal(false)
  const [fileSearchQuery, setFileSearchQuery] = createSignal("")
  const [atPosition, setAtPosition] = createSignal<number | null>(null)
  const [isDragging, setIsDragging] = createSignal(false)
  const [ignoredAtPositions, setIgnoredAtPositions] = createSignal<Set<number>>(new Set())
  let textareaRef: HTMLTextAreaElement | undefined
  let containerRef: HTMLDivElement | undefined

  const attachments = () => getAttachments(props.instanceId, props.sessionId)

  function handleRemoveAttachment(attachmentId: string) {
    removeAttachment(props.instanceId, props.sessionId, attachmentId)

    const currentAttachments = attachments()
    const attachment = currentAttachments.find((a) => a.id === attachmentId)
    if (attachment && attachment.source.type === "file") {
      const filename = attachment.filename
      const currentPrompt = prompt()
      const newPrompt = currentPrompt.replace(`@${filename}`, "").replace(/\s+/g, " ").trim()
      setPrompt(newPrompt)

      if (textareaRef) {
        textareaRef.style.height = "auto"
        textareaRef.style.height = Math.min(textareaRef.scrollHeight, 200) + "px"
      }
    }
  }

  onMount(async () => {
    const loaded = await getHistory(props.instanceFolder)
    setHistory(loaded)
  })

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && !showFilePicker()) {
      e.preventDefault()
      handleSend()
      return
    }

    const textarea = textareaRef
    if (!textarea) return

    const atStart = textarea.selectionStart === 0 && textarea.selectionEnd === 0
    const currentHistory = history()

    if (e.key === "ArrowUp" && !showFilePicker() && atStart && currentHistory.length > 0) {
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

    if (e.key === "ArrowDown" && !showFilePicker() && historyIndex() >= 0) {
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

    if (previousAtPosition !== null && lastAtIndex === -1) {
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
          setFileSearchQuery(textAfterAt)
          setShowFilePicker(true)
        }
        return
      }
    }

    setShowFilePicker(false)
    setAtPosition(null)
  }

  function handleFileSelect(path: string) {
    const filename = path.split("/").pop() || path

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

    setShowFilePicker(false)
    setAtPosition(null)
    setFileSearchQuery("")

    textareaRef?.focus()
  }

  function handleFilePickerClose() {
    const pos = atPosition()
    if (pos !== null) {
      setIgnoredAtPositions((prev) => new Set(prev).add(pos))
    }
    setShowFilePicker(false)
    setAtPosition(null)
    setFileSearchQuery("")
    setTimeout(() => textareaRef?.focus(), 0)
  }

  function handleFilePickerNavigate(_direction: "up" | "down") {}

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
        <Show when={showFilePicker() && instance()}>
          <FilePicker
            open={showFilePicker()}
            onClose={handleFilePickerClose}
            onSelect={handleFileSelect}
            onNavigate={handleFilePickerNavigate}
            instanceClient={instance()!.client}
            searchQuery={fileSearchQuery()}
            textareaRef={textareaRef}
          />
        </Show>

        <div class="flex flex-1 flex-col">
          <Show when={attachments().length > 0}>
            <div class="flex flex-wrap gap-1.5 border-b border-gray-200 pb-2 dark:border-gray-700">
              <For each={attachments()}>
                {(attachment) => (
                  <div class="inline-flex items-center gap-1.5 rounded-md bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700 ring-1 ring-inset ring-blue-700/10 dark:bg-blue-500/10 dark:text-blue-400 dark:ring-blue-500/20">
                    <svg class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                      />
                    </svg>
                    <span>{attachment.filename}</span>
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
                )}
              </For>
            </div>
          </Show>
          <textarea
            ref={textareaRef}
            class="prompt-input"
            placeholder="Type your message, @file, or /command..."
            value={prompt()}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
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
          <Kbd>Enter</Kbd> to send • <Kbd>Shift+Enter</Kbd> for new line • <Kbd>@</Kbd> for files • <Kbd>↑↓</Kbd> for
          history
          <Show when={attachments().length > 0}>
            <span class="ml-2 text-xs text-gray-500">• {attachments().length} file(s) attached</span>
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
