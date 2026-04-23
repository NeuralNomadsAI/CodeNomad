import type { Agent } from "../../types/session"

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

export function normalizeMentionToken(value: string) {
  return value.replace(/[),.:;!?\]\}"']+$/g, "")
}

export function extractMentionTokens(text: string): string[] {
  const matches = text.matchAll(createMentionRegex())
  const tokens: string[] = []
  for (const match of matches) {
    const normalized = normalizeMentionToken(match[1] ?? "")
    if (normalized) tokens.push(normalized)
  }
  return tokens
}

export function findMentionedVisibleAgents(text: string, availableAgents: Agent[], currentAgent: string): string[] {
  const mentionTokens = new Set(extractMentionTokens(text).map((token) => token.toLowerCase()))
  const matches: string[] = []

  for (const agent of availableAgents) {
    const name = agent?.name?.trim()
    if (!name || agent.hidden || name === currentAgent) continue
    if (!mentionTokens.has(name.toLowerCase())) continue
    if (!matches.includes(name)) {
      matches.push(name)
    }
  }

  return matches
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
