import { createEffect, createSignal, type Accessor } from "solid-js"
import { addAttachment, getAttachments, removeAttachment } from "../../stores/attachments"
import { createFileAttachment, createTextAttachment } from "../../types/attachment"
import type { Attachment } from "../../types/attachment"
import { tGlobal } from "../../lib/i18n"
import { getFilePath } from "../../lib/native/file-path"
import { showToastNotification } from "../../lib/notifications"
import {
  bracketedImageDisplayCounterRegex,
  findHighestAttachmentCounters,
  formatImagePlaceholder,
  formatPastedPlaceholder,
  imageDisplayCounterRegex,
  pastedDisplayCounterRegex,
} from "./attachmentPlaceholders"

type PromptAttachmentsOptions = {
  instanceId: Accessor<string>
  sessionId: Accessor<string>
  instanceFolder: Accessor<string>
  prompt: Accessor<string>
  setPrompt: (value: string) => void
  getTextarea: () => HTMLTextAreaElement | null
  disabled?: Accessor<boolean>
}

type PromptAttachments = {
  attachments: Accessor<Attachment[]>
  pasteCount: Accessor<number>
  imageCount: Accessor<number>
  syncAttachmentCounters: (promptText: string) => void

  handlePaste: (e: ClipboardEvent) => Promise<void>
  isDragging: Accessor<boolean>
  handleDragOver: (e: DragEvent) => void
  handleDragLeave: (e: DragEvent) => void
  handleDrop: (e: DragEvent) => void
  handleFileSelection: (files: FileList | File[] | null) => void
  handleNativeFilePathSelection: (paths: string[]) => void

  handleRemoveAttachment: (attachmentId: string) => void
  handleExpandTextAttachment: (attachment: Attachment) => void
}

export function usePromptAttachments(options: PromptAttachmentsOptions): PromptAttachments {
  const attachments = () => getAttachments(options.instanceId(), options.sessionId())
  const [isDragging, setIsDragging] = createSignal(false)
  const [pasteCount, setPasteCount] = createSignal(0)
  const [imageCount, setImageCount] = createSignal(0)
  const MAX_INLINE_PICKED_FILE_BYTES = 5 * 1024 * 1024

  function syncAttachmentCounters(currentPrompt: string) {
    const { highestPaste, highestImage } = findHighestAttachmentCounters(currentPrompt)
    setPasteCount(highestPaste)
    setImageCount(highestImage)
  }

  const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

  function removeTokenFromPrompt(currentPrompt: string, tokenRegex: RegExp) {
    const next = currentPrompt.replace(tokenRegex, "")
    if (next === currentPrompt) return currentPrompt

    return next
      .replace(/[ \t]{2,}/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .trim()
  }

  const createLooseImagePlaceholderRegex = (counter: string | number) =>
    new RegExp(`\\[\\s*Image\\s*#\\s*${counter}\\s*\\]`, "i")
  const createLoosePastedPlaceholderRegex = (counter: string | number) =>
    new RegExp(`\\[\\s*pasted\\s*#\\s*${counter}\\s*\\]`, "i")

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
        if (!createLoosePastedPlaceholderRegex(counter).test(currentPrompt)) {
          toRemove.push(attachment.id)
        }
        continue
      }

      if (attachment.source.type === "file" && attachment.mediaType.startsWith("image/")) {
        const match =
          attachment.display.match(bracketedImageDisplayCounterRegex) || attachment.display.match(imageDisplayCounterRegex)
        if (!match) continue
        const counter = match[1]
        if (!createLooseImagePlaceholderRegex(counter).test(currentPrompt)) {
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

    if (attachment.source.type === "file") {
      if (attachment.mediaType.startsWith("image/")) {
        const imageMatch =
          attachment.display.match(bracketedImageDisplayCounterRegex) || attachment.display.match(imageDisplayCounterRegex)
        if (imageMatch) {
          nextPrompt = removeTokenFromPrompt(currentPrompt, createLooseImagePlaceholderRegex(imageMatch[1]))
        }
      } else {
        // For file mentions we insert `@<path>`, but the chip might display `@<filename>`.
        const candidates = [attachment.source.path, attachment.filename]
        for (const candidate of candidates) {
          if (!candidate) continue
          const mentionRegex = new RegExp(`@${escapeRegExp(candidate)}(?=\\s|$)`, "i")
          nextPrompt = removeTokenFromPrompt(nextPrompt, mentionRegex)
        }
      }
    } else if (attachment.source.type === "agent") {
      const agentName = attachment.filename
      const mentionRegex = new RegExp(`@${escapeRegExp(agentName)}(?=\\s|$)`, "i")
      nextPrompt = removeTokenFromPrompt(currentPrompt, mentionRegex)
    } else if (attachment.source.type === "text") {
      const placeholderMatch = attachment.display.match(pastedDisplayCounterRegex)
      if (placeholderMatch) {
        nextPrompt = removeTokenFromPrompt(currentPrompt, createLoosePastedPlaceholderRegex(placeholderMatch[1]))
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

        const { highestImage } = findHighestAttachmentCounters(options.prompt())
        const count = highestImage + 1
        setImageCount(count)

        const placeholder = formatImagePlaceholder(count)
        const textarea = options.getTextarea()

        if (textarea) {
          const start = textarea.selectionStart
          const end = textarea.selectionEnd
          const currentText = options.prompt()
          const newText = currentText.substring(0, start) + placeholder + currentText.substring(end)
          options.setPrompt(newText)

          setTimeout(() => {
            const newCursorPos = start + placeholder.length
            textarea.setSelectionRange(newCursorPos, newCursorPos)
            textarea.focus()
          }, 0)
        } else {
          options.setPrompt(options.prompt() + placeholder)
        }

        const reader = new FileReader()
        reader.onload = () => {
          const base64Data = (reader.result as string).split(",")[1]
          const filename = `image-${count}.png`

          const attachment = createFileAttachment(
            filename,
            filename,
            "image/png",
            new TextEncoder().encode(base64Data),
            options.instanceFolder(),
          )
          attachment.url = `data:image/png;base64,${base64Data}`
          attachment.display = placeholder
          addAttachment(options.instanceId(), options.sessionId(), attachment)
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

      const { highestPaste } = findHighestAttachmentCounters(options.prompt())
      const count = highestPaste + 1
      setPasteCount(count)

      const summary = lineCount > 1 ? `${lineCount} lines` : `${charCount} chars`
      const display = `pasted #${count} (${summary})`
      const filename = `paste-${count}.txt`

      const attachment = createTextAttachment(pastedText, display, filename)
      const placeholder = formatPastedPlaceholder(count)
      const textarea = options.getTextarea()
      if (textarea) {
        const start = textarea.selectionStart
        const end = textarea.selectionEnd
        const currentText = options.prompt()
        const newText = currentText.substring(0, start) + placeholder + currentText.substring(end)
        options.setPrompt(newText)

        setTimeout(() => {
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
    if (options.disabled?.()) {
      setIsDragging(false)
      return
    }
    setIsDragging(true)
  }

  function getFilenameFromPath(path: string) {
    const normalized = path.replace(/\\/g, "/")
    return normalized.split("/").pop() || path
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

    return imageMimeTypes[extension] ?? textMimeTypes[extension] ?? "application/octet-stream"
  }

  function showSkippedFilesWarning(count: number) {
    if (count <= 0) return
    const messageKey = count === 1
      ? "promptInput.attachFiles.skipped.one"
      : "promptInput.attachFiles.skipped.other"
    showToastNotification({
      variant: "warning",
      title: tGlobal("promptInput.attachFiles.skipped.title"),
      message: tGlobal(messageKey, { count }),
    })
  }

  function handleNativeFilePathSelection(paths: string[]) {
    if (options.disabled?.()) return
    for (const path of paths) {
      if (!path || path.trim().length === 0) continue
      const filename = getFilenameFromPath(path)
      const attachment = createFileAttachment(path, filename, inferMimeTypeFromPath(path), undefined, options.instanceFolder())
      addAttachment(options.instanceId(), options.sessionId(), attachment)
    }
    options.getTextarea()?.focus()
  }

  function handleDragLeave(e: DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  function handleFileSelection(files: FileList | File[] | null) {
    if (options.disabled?.()) return
    if (!files || files.length === 0) return

    let skippedCount = 0

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const nativePath = getFilePath(file)
      const filename = file.name
      const mime = file.type || "application/octet-stream"
      const canInlinePreview = (mime.startsWith("image/") || mime.startsWith("text/")) && file.size <= MAX_INLINE_PICKED_FILE_BYTES

      if (!nativePath && !canInlinePreview) {
        skippedCount += 1
        continue
      }

      const path = nativePath || filename

      const createAndStoreAttachment = (previewUrl?: string) => {
        const attachment = createFileAttachment(path, filename, mime, undefined, options.instanceFolder())
        if (previewUrl) {
          attachment.url = previewUrl
        }
        addAttachment(options.instanceId(), options.sessionId(), attachment)
      }

      if (canInlinePreview && typeof FileReader !== "undefined") {
        const reader = new FileReader()
        reader.onload = () => {
          const result = typeof reader.result === "string" ? reader.result : undefined
          createAndStoreAttachment(result)
        }
        reader.onerror = () => {
          if (nativePath) {
            createAndStoreAttachment()
          }
        }
        reader.readAsDataURL(file)
      } else {
        createAndStoreAttachment()
      }
    }

    showSkippedFilesWarning(skippedCount)

    options.getTextarea()?.focus()
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    if (options.disabled?.()) return

    handleFileSelection(e.dataTransfer?.files ?? null)
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
    handleFileSelection,
    handleNativeFilePathSelection,
    handleRemoveAttachment,
    handleExpandTextAttachment,
  }
}
