export function formatPastedPlaceholder(value: string | number) {
  return `[pasted #${value}]`
}

export function formatImagePlaceholder(value: string | number) {
  return `[Image #${value}]`
}

export function createPastedPlaceholderRegex() {
  return /\[\s*pasted\s*#\s*(\d+)\s*\]/gi
}

export function createImagePlaceholderRegex() {
  return /\[\s*Image\s*#\s*(\d+)\s*\]/gi
}

export function createMentionRegex() {
  return /@(\S+)/g
}

export const pastedDisplayCounterRegex = /pasted #(\d+)/i
export const imageDisplayCounterRegex = /Image #(\d+)/i
export const bracketedImageDisplayCounterRegex = /\[\s*Image\s*#\s*(\d+)\s*\]/i

export function parseCounter(value: string) {
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? null : parsed
}

export function findHighestAttachmentCounters(currentPrompt: string) {
  let highestPaste = 0
  let highestImage = 0

  for (const match of currentPrompt.matchAll(createPastedPlaceholderRegex())) {
    const parsed = parseCounter(match[1])
    if (parsed !== null) {
      highestPaste = Math.max(highestPaste, parsed)
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
