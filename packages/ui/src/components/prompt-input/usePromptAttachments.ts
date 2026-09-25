import { createEffect, createSignal, type Accessor } from "solid-js"
import { addAttachment, getAttachments, removeAttachment } from "../../stores/attachments"
import { createTextAttachment } from "../../types/attachment"
import type { Attachment } from "../../types/attachment"
import { createAttachmentPlaceholderRegex } from "../../lib/attachment-placeholders"
import { createPromptMentionRegex, getAttachmentPromptMentionCandidates } from "../../lib/attachment-mentions"
import {
  bracketedImageDisplayCounterRegex,
  findHighestAttachmentCounters,
  formatPastedPlaceholder,
  imageDisplayCounterRegex,
  pastedDisplayCounterRegex,
} from "./attachmentPlaceholders"
import { useDeviceAttachments } from "./useDeviceAttachments"

type PromptAttachmentsOptions = {
  instanceId: Accessor<string>
  sessionId: Accessor<string>
  instanceFolder: Accessor<string>
  prompt: Accessor<string>
  setPrompt: (value: string) => void
  getTextarea: () => HTMLTextAreaElement | null
  disabled?: Accessor<boolean>
  active?: Accessor<boolean>
}

type PromptAttachments = {
  attachments: Accessor<Attachment[]>
  pasteCount: Accessor<number>
  imageCount: Accessor<number>
  syncAttachmentCounters: (promptText: string) => void

  handlePaste: (e: ClipboardEvent) => Promise<void>
  isDragging: Accessor<boolean>
  isReadingFiles: Accessor<boolean>
  handleDragOver: (e: DragEvent) => void
  handleDragLeave: (e: DragEvent) => void
  handleDrop: (e: DragEvent) => void
  handleUploadFiles: () => void

  handleRemoveAttachment: (attachmentId: string) => void
  handleExpandTextAttachment: (attachment: Attachment) => void
}

export function usePromptAttachments(options: PromptAttachmentsOptions): PromptAttachments {
  const attachments = () => getAttachments(options.instanceId(), options.sessionId())
  const [isDragging, setIsDragging] = createSignal(false)
  const [pasteCount, setPasteCount] = createSignal(0)
  const [imageCount, setImageCount] = createSignal(0)
  const device = useDeviceAttachments({ ...options, inferMime: inferMimeTypeFromPath })

  function syncAttachmentCounters(currentPrompt: string) {
    const { highestPaste, highestImage } = findHighestAttachmentCounters(currentPrompt)
    setPasteCount(highestPaste)
    setImageCount(highestImage)
  }

  function removeTokenFromPrompt(currentPrompt: string, tokenRegex: RegExp) {
    const next = currentPrompt.replace(tokenRegex, "")
    if (next === currentPrompt) return currentPrompt

    return next
      .replace(/[ \t]{2,}/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .trim()
  }

  // Keep placeholder-backed attachments in sync with prompt text.
  // If the placeholder token disappears from the prompt, the attachment should disappear too.
  createEffect(() => {
    const currentPrompt = options.prompt()
    const currentAttachments = attachments()

    const toRemove: string[] = []

    for (const attachment of currentAttachments) {
      if (attachment.source.type === "text") {
        const match = attachment.display.match(pastedDisplayCounterRegex)
        if (!match) continue
        const counter = match[1]
        if (!createAttachmentPlaceholderRegex("pasted", counter, { global: false }).test(currentPrompt)) {
          toRemove.push(attachment.id)
        }
        continue
      }

      if (attachment.source.type === "file" && attachment.mediaType.startsWith("image/")) {
        const match =
          attachment.display.match(bracketedImageDisplayCounterRegex) || attachment.display.match(imageDisplayCounterRegex)
        if (!match) continue
        const counter = match[1]
        if (!createAttachmentPlaceholderRegex("image", counter, { global: false }).test(currentPrompt)) {
          toRemove.push(attachment.id)
        }
      }
    }

    for (const attachmentId of toRemove) {
      removeAttachment(options.instanceId(), options.sessionId(), attachmentId)
    }
  })

  function handleRemoveAttachment(attachmentId: string) {
    const currentAttachments = attachments()
    const attachment = currentAttachments.find((a) => a.id === attachmentId)

    // Always remove from store.
    removeAttachment(options.instanceId(), options.sessionId(), attachmentId)

    if (!attachment) return

    const currentPrompt = options.prompt()
    let nextPrompt = currentPrompt

    let hasPlaceholder = false
    if (attachment.source.type === "file") {
      if (attachment.mediaType.startsWith("image/")) {
        const imageMatch =
          attachment.display.match(bracketedImageDisplayCounterRegex) || attachment.display.match(imageDisplayCounterRegex)
        if (imageMatch) {
          hasPlaceholder = true
          nextPrompt = removeTokenFromPrompt(
            currentPrompt,
            createAttachmentPlaceholderRegex("image", imageMatch[1], { global: false }),
          )
        }
      }
    } else if (attachment.source.type === "text") {
      const placeholderMatch = attachment.display.match(pastedDisplayCounterRegex)
      if (placeholderMatch) {
        hasPlaceholder = true
        nextPrompt = removeTokenFromPrompt(
          currentPrompt,
          createAttachmentPlaceholderRegex("pasted", placeholderMatch[1], { global: false }),
        )
      }
    }

    if (!hasPlaceholder) {
      for (const candidate of getAttachmentPromptMentionCandidates(attachment)) {
        nextPrompt = removeTokenFromPrompt(nextPrompt, createPromptMentionRegex(candidate))
      }
    }

    if (nextPrompt !== currentPrompt) {
      options.setPrompt(nextPrompt)
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
      const owner = device.capture()
      setTimeout(() => {
        if (!owner.current()) return
        textarea.focus()
        if (selectionTarget !== null) {
          textarea.setSelectionRange(selectionTarget, selectionTarget)
        }
      }, 0)
    }
  }

  async function handlePaste(e: ClipboardEvent) {
    if (options.disabled?.() || options.active?.() === false) return
    const items = e.clipboardData?.items
    if (!items) return
    const files = Array.from(items).filter(item => item.kind === "file").flatMap(item => {
      const file = item.getAsFile()
      return file ? [file] : []
    })
    if (files.length) {
      e.preventDefault()
      await device.enqueue(files, true)
      return
    }

    const pastedText = e.clipboardData?.getData("text/plain")
    if (!pastedText) return

    const lineCount = pastedText.split("\n").length
    const charCount = pastedText.length

    const isLongPaste = charCount > 150 || lineCount > 3

    if (isLongPaste) {
      e.preventDefault()

      const { highestPaste } = findHighestAttachmentCounters(options.prompt())
      const count = highestPaste + 1
      setPasteCount(count)

      const summary = lineCount > 1 ? `${lineCount} lines` : `${charCount} chars`
      const display = `pasted #${count} (${summary})`
      const filename = `paste-${count}.txt`

      const attachment = createTextAttachment(pastedText, display, filename)
      const owner = device.capture()
      const placeholder = formatPastedPlaceholder(count)
      const textarea = options.getTextarea()
      if (textarea) {
        const start = textarea.selectionStart
        const end = textarea.selectionEnd
        const currentText = options.prompt()
        const newText = currentText.substring(0, start) + placeholder + currentText.substring(end)
        options.setPrompt(newText)

        setTimeout(() => {
          if (!owner.current()) return
          const newCursorPos = start + placeholder.length
          textarea.setSelectionRange(newCursorPos, newCursorPos)
          textarea.focus()
        }, 0)
      } else {
        options.setPrompt(options.prompt() + placeholder)
      }

      addAttachment(options.instanceId(), options.sessionId(), attachment)
    }
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    if (options.disabled?.() || options.active?.() === false) {
      setIsDragging(false)
      return
    }
    setIsDragging(true)
  }

  function inferMimeTypeFromPath(path: string) {
    const extension = path.split(/[\\/]/).pop()?.toLowerCase().match(/\.([^.]+)$/)?.[1]
    if (!extension) return "application/octet-stream"

    const imageMimeTypes: Record<string, string> = {
      apng: "image/apng",
      avif: "image/avif",
      gif: "image/gif",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      svg: "image/svg+xml",
      webp: "image/webp",
    }
    const textMimeTypes: Record<string, string> = {
      bashrc: "text/plain",
      c: "text/x-c",
      config: "text/plain",
      cpp: "text/x-c++src",
      cs: "text/x-csharp",
      css: "text/css",
      csv: "text/csv",
      env: "text/plain",
      gitignore: "text/plain",
      go: "text/x-go",
      h: "text/x-c",
      hpp: "text/x-c++hdr",
      html: "text/html",
      java: "text/x-java-source",
      js: "text/javascript",
      json: "application/json",
      jsx: "text/javascript",
      log: "text/plain",
      md: "text/markdown",
      mjs: "text/javascript",
      py: "text/x-python",
      rs: "text/x-rust",
      sh: "text/x-shellscript",
      toml: "text/toml",
      ts: "text/typescript",
      tsx: "text/typescript",
      txt: "text/plain",
      xml: "application/xml",
      yaml: "application/yaml",
      yml: "application/yaml",
    }

    return imageMimeTypes[extension] ?? textMimeTypes[extension] ?? (extension === "pdf" ? "application/pdf" : "application/octet-stream")
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

    void device.enqueue(Array.from(e.dataTransfer?.files ?? []))
  }

  return {
    attachments,
    pasteCount,
    imageCount,
    syncAttachmentCounters,
    handlePaste,
    isDragging,
    isReadingFiles: device.isReadingFiles,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleUploadFiles: device.handleUploadFiles,
    handleRemoveAttachment,
    handleExpandTextAttachment,
  }
}
