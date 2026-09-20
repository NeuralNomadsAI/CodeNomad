import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import { addAttachment, getAttachments, removeAttachment } from "../../stores/attachments"
import { createFileAttachment, createTextAttachment } from "../../types/attachment"
import type { Attachment } from "../../types/attachment"
import { createAttachmentPlaceholderRegex } from "../../lib/attachment-placeholders"
import { createPromptMentionRegex, getAttachmentPromptMentionCandidates } from "../../lib/attachment-mentions"
import { tGlobal } from "../../lib/i18n"
import { showToastNotification } from "../../lib/notifications"
import { PROMPT_INLINE_FILE_LIMITS } from "../../../../server/src/api-types"
import {
  bracketedImageDisplayCounterRegex,
  findHighestAttachmentCounters,
  formatImagePlaceholder,
  formatPastedPlaceholder,
  imageDisplayCounterRegex,
  pastedDisplayCounterRegex,
} from "./attachmentPlaceholders"
import { getInlineFileUsage, readDeviceFileSelection } from "./device-file-selection"

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
  isReadingFiles: Accessor<boolean>
  handleDragOver: (e: DragEvent) => void
  handleDragLeave: (e: DragEvent) => void
  handleDrop: (e: DragEvent) => void
  handleDeviceFileSelection: (files: FileList | readonly File[] | null) => Promise<void>
  handleFilePathAttachment: (path: string, contents: string, options?: { encoding?: "utf-8" | "base64" }) => void

  handleRemoveAttachment: (attachmentId: string) => void
  handleExpandTextAttachment: (attachment: Attachment) => void
}

export function usePromptAttachments(options: PromptAttachmentsOptions): PromptAttachments {
  const attachments = () => getAttachments(options.instanceId(), options.sessionId())
  const [isDragging, setIsDragging] = createSignal(false)
  const [pendingFileReads, setPendingFileReads] = createSignal(0)
  const [pasteCount, setPasteCount] = createSignal(0)
  const [imageCount, setImageCount] = createSignal(0)
  let disposed = false
  onCleanup(() => { disposed = true })

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
    if (options.disabled?.() || pendingFileReads() > 0) {
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

    return imageMimeTypes[extension] ?? textMimeTypes[extension] ?? (extension === "pdf" ? "application/pdf" : "application/octet-stream")
  }

  function showTooLargeFilesWarning(count: number) {
    if (count <= 0) return
    showToastNotification({
      variant: "warning",
      title: tGlobal("promptInput.attachFiles.skipped.title"),
      message: tGlobal(
        count === 1 ? "promptInput.attachFiles.tooLarge.one" : "promptInput.attachFiles.tooLarge.other",
        { count },
      ),
    })
  }

  function showAttachmentBudgetWarning(count: number) {
    if (count <= 0) return
    showToastNotification({
      variant: "warning",
      title: tGlobal("promptInput.attachFiles.skipped.title"),
      message: tGlobal(
        count === 1 ? "promptInput.attachFiles.limit.one" : "promptInput.attachFiles.limit.other",
        {
          count,
          maxFiles: PROMPT_INLINE_FILE_LIMITS.maxFiles,
          maxMegabytes: PROMPT_INLINE_FILE_LIMITS.maxTotalBytes / (1024 * 1024),
        },
      ),
    })
  }

  function showDeviceSelectionWarning(count: number) {
    if (count <= 0) return
    showToastNotification({
      variant: "warning",
      title: tGlobal("promptInput.attachFiles.skipped.title"),
      message: tGlobal(
        count === 1 ? "promptInput.attachFiles.deviceRejected.one" : "promptInput.attachFiles.deviceRejected.other",
        {
          count,
          maxFileMegabytes: PROMPT_INLINE_FILE_LIMITS.maxFileBytes / (1024 * 1024),
          maxFiles: PROMPT_INLINE_FILE_LIMITS.maxFiles,
          maxTotalMegabytes: PROMPT_INLINE_FILE_LIMITS.maxTotalBytes / (1024 * 1024),
        },
      ),
    })
  }

  function encodeBytesAsBase64(bytes: Uint8Array) {
    let binary = ""
    const chunkSize = 0x8000
    for (let index = 0; index < bytes.length; index += chunkSize) {
      const chunk = bytes.subarray(index, Math.min(index + chunkSize, bytes.length))
      binary += String.fromCharCode(...chunk)
    }
    return btoa(binary)
  }

  function decodeBase64ToBytes(value: string) {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  }

  function attachFileData(
    path: string,
    filename: string,
    mime: string,
    data: Uint8Array,
    previewUrl?: string,
  ): "attached" | "too-large" | "budget" {
    if (data.byteLength > PROMPT_INLINE_FILE_LIMITS.maxFileBytes) return "too-large"
    const usage = getInlineFileUsage(attachments())
    if (
      usage.count + 1 > PROMPT_INLINE_FILE_LIMITS.maxFiles
      || usage.bytes + data.byteLength > PROMPT_INLINE_FILE_LIMITS.maxTotalBytes
    ) return "budget"
    const attachment = createFileAttachment(path, filename, mime, data, options.instanceFolder())
    attachment.url = previewUrl ?? `data:${mime};base64,${encodeBytesAsBase64(data)}`
    addAttachment(options.instanceId(), options.sessionId(), attachment)
    return "attached"
  }

  function handleFilePathAttachment(path: string, contents: string, attachmentOptions?: { encoding?: "utf-8" | "base64" }) {
    if (options.disabled?.()) return
    if (!path || path.trim().length === 0) return

    const filename = getFilenameFromPath(path)
    const mime = inferMimeTypeFromPath(path)
    const data = attachmentOptions?.encoding === "base64" ? decodeBase64ToBytes(contents) : new TextEncoder().encode(contents)
    const result = attachFileData(path, filename, mime, data)
    if (result === "too-large") showTooLargeFilesWarning(1)
    if (result === "budget") showAttachmentBudgetWarning(1)
    options.getTextarea()?.focus()
  }

  function handleDragLeave(e: DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  async function handleDeviceFileSelection(files: FileList | readonly File[] | null) {
    if (options.disabled?.() || pendingFileReads() > 0) return
    if (!files || files.length === 0) return

    const instanceId = options.instanceId()
    const sessionId = options.sessionId()
    const isCurrent = () => !disposed && options.instanceId() === instanceId && options.sessionId() === sessionId
    setPendingFileReads(count => count + 1)
    try {
      const result = await readDeviceFileSelection(files, attachments(), isCurrent)
      if (result.stale || !isCurrent()) return

      let commitRejections = 0
      for (const selected of result.files) {
        const filename = selected.file.name
        const mime = selected.file.type || inferMimeTypeFromPath(filename)
        const previewUrl = `data:${mime};base64,${encodeBytesAsBase64(selected.data)}`
        if (attachFileData(filename, filename, mime, selected.data, previewUrl) !== "attached") {
          commitRejections += 1
        }
      }
      showDeviceSelectionWarning(
        result.tooLargeCount + result.overBudgetCount + result.unreadableCount + commitRejections,
      )
    } finally {
      setPendingFileReads(count => Math.max(0, count - 1))
      if (isCurrent()) options.getTextarea()?.focus()
    }
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    if (options.disabled?.() || pendingFileReads() > 0) return

    void handleDeviceFileSelection(e.dataTransfer?.files ?? null)
  }

  return {
    attachments,
    pasteCount,
    imageCount,
    syncAttachmentCounters,
    handlePaste,
    isDragging,
    isReadingFiles: () => pendingFileReads() > 0,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleDeviceFileSelection,
    handleFilePathAttachment,
    handleRemoveAttachment,
    handleExpandTextAttachment,
  }
}
