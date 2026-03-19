export interface PromptVoiceAnchor {
  prompt: string
  start: number
  end: number
}

export function createPromptVoiceAnchor(prompt: string, start: number, end: number): PromptVoiceAnchor {
  return { prompt, start, end }
}

export function buildPromptWithInsertedTranscript(anchor: PromptVoiceAnchor, insertedText: string): { value: string; cursor: number } {
  const before = anchor.prompt.slice(0, anchor.start)
  const after = anchor.prompt.slice(anchor.end)
  const normalized = insertedText.trim()

  if (!normalized) {
    return {
      value: before + after,
      cursor: before.length,
    }
  }

  const prefix = before.length > 0 && !/\s$/.test(before) ? " " : ""
  const suffix = after.length > 0 && !/^\s/.test(after) ? " " : ""
  return {
    value: `${before}${prefix}${normalized}${suffix}${after}`,
    cursor: before.length + prefix.length + normalized.length,
  }
}

export function appendVoiceTranscript(current: string, next: string): string {
  const normalized = next.trim()
  if (!normalized) return current
  if (!current.trim()) return normalized
  return /\s$/.test(current) ? `${current}${normalized}` : `${current} ${normalized}`
}
