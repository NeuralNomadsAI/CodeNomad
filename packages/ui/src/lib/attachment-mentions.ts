import { createAttachmentPlaceholderRegex, getAttachmentPlaceholder } from "./attachment-placeholders"

const MAX_MENTION_LENGTH = 4096
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export function getAttachmentPromptMentionCandidates(value: unknown): string[] {
  if (!isRecord(value)) return []
  const source = isRecord(value.source) ? value.source : {}
  const candidates: unknown[] = [
    typeof value.display === "string" && value.display.startsWith("@") ? value.display.slice(1) : undefined,
  ]

  if (source.type === "file") {
    candidates.push(source.path, value.filename)
    if (source.mime === "inode/directory" && typeof source.path === "string") {
      const path = source.path.replace(/\/+$/, "")
      candidates.push(path === "" || path === "." ? "./" : `${path}/`)
      if (path !== "" && path !== ".") candidates.push(`${path.replace(/^\.\//, "")}/`)
    }
  } else if (source.type === "agent") {
    candidates.push(source.name, value.filename)
  } else if (
    source.type === "text" &&
    typeof source.value === "string" &&
    value.display === `path: ${source.value}`
  ) {
    candidates.push(source.value)
  }

  return [...new Set(candidates.filter(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.length > 0 && candidate.length <= MAX_MENTION_LENGTH,
  ))]
}

export function createPromptMentionRegex(candidate: string, options: { global?: boolean } = {}): RegExp {
  // Picker paths are inserted literally, including spaces; escaping is only for regex matching.
  return new RegExp(`@${escapeRegExp(candidate)}(?=\\s|$)`, options.global ? "gi" : "i")
}

export function removeAttachmentPromptTokens(prompt: string, attachment: unknown): string {
  const display = isRecord(attachment) ? attachment.display : undefined
  const placeholder = getAttachmentPlaceholder(display)
  if (placeholder) {
    return prompt.replace(createAttachmentPlaceholderRegex(placeholder.kind, placeholder.counter), "")
  }
  for (const candidate of getAttachmentPromptMentionCandidates(attachment)) {
    prompt = prompt.replace(createPromptMentionRegex(candidate, { global: true }), "")
  }
  return prompt
}
