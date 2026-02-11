import type { Attachment } from "../../types/attachment"

export function formatPastedPlaceholder(value: string | number) {
  return `[pasted #${value}]`
}

export function formatImagePlaceholder(value: string | number) {
  return `[Image #${value}]`
}

export function createPastedPlaceholderRegex() {
  return /\[pasted #(\d+)\]/g
}

export function createImagePlaceholderRegex() {
  return /\[Image #(\d+)\]/g
}

export function createMentionRegex() {
  return /@(\S+)/g
}

export const pastedDisplayCounterRegex = /pasted #(\d+)/
export const imageDisplayCounterRegex = /Image #(\d+)/
export const bracketedImageDisplayCounterRegex = /\[Image #(\d+)\]/

export function parseCounter(value: string) {
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? null : parsed
}

export function findHighestAttachmentCounters(currentPrompt: string, sessionAttachments: Attachment[]) {
  let highestPaste = 0
  let highestImage = 0

  for (const match of currentPrompt.matchAll(createPastedPlaceholderRegex())) {
    const parsed = parseCounter(match[1])
    if (parsed !== null) {
      highestPaste = Math.max(highestPaste, parsed)
    }
  }

  for (const attachment of sessionAttachments) {
    if (attachment.source.type === "text") {
      const placeholderMatch = attachment.display.match(pastedDisplayCounterRegex)
      if (placeholderMatch) {
        const parsed = parseCounter(placeholderMatch[1])
        if (parsed !== null) {
          highestPaste = Math.max(highestPaste, parsed)
        }
      }
    }
    if (attachment.source.type === "file" && attachment.mediaType.startsWith("image/")) {
      const imageMatch = attachment.display.match(imageDisplayCounterRegex)
      if (imageMatch) {
        const parsed = parseCounter(imageMatch[1])
        if (parsed !== null) {
          highestImage = Math.max(highestImage, parsed)
        }
      }
    }
  }

  for (const match of currentPrompt.matchAll(createImagePlaceholderRegex())) {
    const parsed = parseCounter(match[1])
    if (parsed !== null) {
      highestImage = Math.max(highestImage, parsed)
    }
  }

  return { highestPaste, highestImage }
}
