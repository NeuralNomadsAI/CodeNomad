import { createSignal, type Accessor } from "solid-js"
import { addAttachment, getAttachments, removeAttachment } from "../../stores/attachments"
import { createFileAttachment, createTextAttachment } from "../../types/attachment"
import type { Attachment } from "../../types/attachment"
import {
  bracketedImageDisplayCounterRegex,
  findHighestAttachmentCounters,
  formatImagePlaceholder,
  formatPastedPlaceholder,
  pastedDisplayCounterRegex,
} from "./attachmentPlaceholders"

type PromptAttachmentsOptions = {
  instanceId: Accessor<string>
  sessionId: Accessor<string>
  instanceFolder: Accessor<string>
  prompt: Accessor<string>
  setPrompt: (value: string) => void
  getTextarea: () => HTMLTextAreaElement | null
}

type PromptAttachments = {
  attachments: Accessor<Attachment[]>
  pasteCount: Accessor<number>
  imageCount: Accessor<number>
  syncAttachmentCounters: (promptText: string, sessionAttachments: Attachment[]) => void

  handlePaste: (e: ClipboardEvent) => Promise<void>
  isDragging: Accessor<boolean>
  handleDragOver: (e: DragEvent) => void
  handleDragLeave: (e: DragEvent) => void
  handleDrop: (e: DragEvent) => void

  handleRemoveAttachment: (attachmentId: string) => void
  handleExpandTextAttachment: (attachment: Attachment) => void
}

export function usePromptAttachments(options: PromptAttachmentsOptions): PromptAttachments {
  const attachments = () => getAttachments(options.instanceId(), options.sessionId())
  const [isDragging, setIsDragging] = createSignal(false)
  const [pasteCount, setPasteCount] = createSignal(0)
  const [imageCount, setImageCount] = createSignal(0)

  function syncAttachmentCounters(currentPrompt: string, sessionAttachments: Attachment[]) {
    const { highestPaste, highestImage } = findHighestAttachmentCounters(currentPrompt, sessionAttachments)
    setPasteCount(highestPaste)
    setImageCount(highestImage)
  }

  function handleRemoveAttachment(attachmentId: string) {
    const currentAttachments = attachments()
    const attachment = currentAttachments.find((a) => a.id === attachmentId)

    removeAttachment(options.instanceId(), options.sessionId(), attachmentId)

    if (attachment) {
      const currentPrompt = options.prompt()
      let newPrompt = currentPrompt

      if (attachment.source.type === "file") {
        if (attachment.mediaType.startsWith("image/")) {
          const imageMatch = attachment.display.match(bracketedImageDisplayCounterRegex)
          if (imageMatch) {
            const placeholder = formatImagePlaceholder(imageMatch[1])
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
        const placeholderMatch = attachment.display.match(pastedDisplayCounterRegex)
        if (placeholderMatch) {
          const placeholder = formatPastedPlaceholder(placeholderMatch[1])
          newPrompt = currentPrompt.replace(placeholder, "").replace(/\s+/g, " ").trim()
        }
      }

      options.setPrompt(newPrompt)
    }
  }

  function handleExpandTextAttachment(attachment: Attachment) {
    if (attachment.source.type !== "text") return

    const textarea = options.getTextarea()
    const value = attachment.source.value
    const match = attachment.display.match(pastedDisplayCounterRegex)
    const placeholder = match ? formatPastedPlaceholder(match[1]) : null
    const currentText = options.prompt()

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

    options.setPrompt(nextText)
    removeAttachment(options.instanceId(), options.sessionId(), attachment.id)

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
          const display = formatImagePlaceholder(count)
          const filename = `image-${count}.png`

          const attachment = createFileAttachment(
            filename,
            filename,
            "image/png",
            new TextEncoder().encode(base64Data),
            options.instanceFolder(),
          )
          attachment.url = `data:image/png;base64,${base64Data}`
          attachment.display = display
          addAttachment(options.instanceId(), options.sessionId(), attachment)

          const textarea = options.getTextarea()
          if (textarea) {
            const start = textarea.selectionStart
            const end = textarea.selectionEnd
            const currentText = options.prompt()
            const placeholder = formatImagePlaceholder(count)
            const newText = currentText.substring(0, start) + placeholder + currentText.substring(end)
            options.setPrompt(newText)

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
      addAttachment(options.instanceId(), options.sessionId(), attachment)

      const textarea = options.getTextarea()
      if (textarea) {
        const start = textarea.selectionStart
        const end = textarea.selectionEnd
        const currentText = options.prompt()
        const placeholder = formatPastedPlaceholder(count)
        const newText = currentText.substring(0, start) + placeholder + currentText.substring(end)
        options.setPrompt(newText)

        setTimeout(() => {
          const newCursorPos = start + placeholder.length
          textarea.setSelectionRange(newCursorPos, newCursorPos)
          textarea.focus()
        }, 0)
      }
    }
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
        const attachment = createFileAttachment(path, filename, mime, undefined, options.instanceFolder())
        if (previewUrl && (mime.startsWith("image/") || mime.startsWith("text/"))) {
          attachment.url = previewUrl
        }
        addAttachment(options.instanceId(), options.sessionId(), attachment)
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

    options.getTextarea()?.focus()
  }

  return {
    attachments,
    pasteCount,
    imageCount,
    syncAttachmentCounters,
    handlePaste,
    isDragging,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleRemoveAttachment,
    handleExpandTextAttachment,
  }
}
