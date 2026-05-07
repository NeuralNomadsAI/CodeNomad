import type { ClientPart, MessageInfo } from "../types/message"
import { isHiddenSyntheticTextPart } from "../types/message"
import type { InstanceMessageStore } from "../stores/message-v2/instance-store"
import type { MessageRecord, MessageRole } from "../stores/message-v2/types"

export interface SessionSearchMatch {
  id: string
  messageId: string
  partId?: string
  partType?: string
  role: MessageRole
  start: number
  end: number
  occurrence: number
  preview: string
}

interface SearchablePartText {
  partId?: string
  partType?: string
  text: string
}

export interface BuildSessionSearchMatchesOptions {
  store: InstanceMessageStore
  sessionId: string
  query: string
  includeThinking: boolean
}

const PREVIEW_RADIUS = 56
const TOOL_TEXT_LIMIT = 1000

function normalizeSearchValue(value: string): string {
  return value.toLocaleLowerCase()
}

function segmentToText(segment: unknown): string {
  if (typeof segment === "string") return segment
  if (!segment || typeof segment !== "object") return ""

  const candidate = segment as { text?: unknown; value?: unknown; content?: unknown[] }
  const parts: string[] = []
  if (typeof candidate.text === "string") parts.push(candidate.text)
  if (typeof candidate.value === "string") parts.push(candidate.value)
  if (Array.isArray(candidate.content)) {
    parts.push(candidate.content.map((entry) => segmentToText(entry)).filter(Boolean).join("\n"))
  }
  return parts.filter(Boolean).join("\n")
}

function extractReasoningText(part: ClientPart): string {
  const text = segmentToText((part as any).text)
  const content = Array.isArray((part as any).content)
    ? (part as any).content.map((entry: unknown) => segmentToText(entry)).filter(Boolean).join("\n")
    : ""
  return [text, content].filter(Boolean).join("\n")
}

function extractToolText(part: Extract<ClientPart, { type: "tool" }>): string {
  const state = (part as any).state
  const metadata = state && typeof state === "object" ? ((state as any).metadata ?? {}) : {}
  const values: string[] = []

  if (typeof part.tool === "string") values.push(part.tool)
  if (typeof metadata.title === "string") values.push(metadata.title)
  if (typeof metadata.description === "string") values.push(metadata.description)

  const candidateStrings = [
    (part as any).command,
    (part as any).path,
    (part as any).file,
    (part as any).filename,
    (part as any).input,
    state?.title,
    state?.command,
    state?.path,
    state?.file,
    state?.filename,
    state?.message,
    state?.error,
  ]

  for (const value of candidateStrings) {
    if (typeof value === "string" && value.trim().length > 0) {
      values.push(value.slice(0, TOOL_TEXT_LIMIT))
    }
  }

  return values.filter(Boolean).join("\n")
}

function extractMessageInfoText(info: MessageInfo | undefined): string {
  if (!info || info.role !== "assistant" || !info.error) return ""
  const error = info.error as { data?: { message?: unknown }; message?: unknown; name?: unknown }
  const values = [error.data?.message, error.message, error.name]
  return values.filter((value): value is string => typeof value === "string" && value.trim().length > 0).join("\n")
}

function extractSearchablePartText(part: ClientPart, includeThinking: boolean): SearchablePartText | null {
  if (!part || typeof part !== "object") return null
  if (isHiddenSyntheticTextPart(part)) return null

  const partId = typeof (part as any).id === "string" ? (part as any).id : undefined
  const partType = typeof (part as any).type === "string" ? (part as any).type : undefined

  if (part.type === "text") {
    const text = typeof (part as any).text === "string" ? (part as any).text : segmentToText((part as any).text)
    return text.trim().length > 0 ? { partId, partType, text } : null
  }

  if (part.type === "reasoning") {
    if (!includeThinking) return null
    const text = extractReasoningText(part)
    return text.trim().length > 0 ? { partId, partType, text } : null
  }

  if (part.type === "file") {
    const filename = (part as any).filename
    return typeof filename === "string" && filename.trim().length > 0 ? { partId, partType, text: filename } : null
  }

  if (part.type === "tool") {
    const text = extractToolText(part)
    return text.trim().length > 0 ? { partId, partType, text } : null
  }

  if (part.type === "compaction") {
    const text = (part as any).auto ? "Session auto-compacted" : "Session compacted"
    return { partId, partType, text }
  }

  return null
}

function buildPreview(text: string, start: number, end: number): string {
  const from = Math.max(0, start - PREVIEW_RADIUS)
  const to = Math.min(text.length, end + PREVIEW_RADIUS)
  const prefix = from > 0 ? "..." : ""
  const suffix = to < text.length ? "..." : ""
  return `${prefix}${text.slice(from, to).replace(/\s+/g, " ").trim()}${suffix}`
}

function collectRecordSearchableText(store: InstanceMessageStore, record: MessageRecord, includeThinking: boolean): SearchablePartText[] {
  const results: SearchablePartText[] = []
  for (const partId of record.partIds) {
    const part = record.parts[partId]?.data
    if (!part) continue
    const text = extractSearchablePartText(part, includeThinking)
    if (text) results.push(text)
  }

  const infoText = extractMessageInfoText(store.getMessageInfo(record.id))
  if (infoText.trim().length > 0) {
    results.push({ partType: "error", text: infoText })
  }

  return results
}

export function buildSessionSearchMatches(options: BuildSessionSearchMatchesOptions): SessionSearchMatch[] {
  const query = options.query.trim()
  if (!query) return []

  const needle = normalizeSearchValue(query)
  const matches: SessionSearchMatch[] = []
  const messageIds = options.store.getSessionMessageIds(options.sessionId)

  for (const messageId of messageIds) {
    const record = options.store.getMessage(messageId)
    if (!record) continue
    const searchableParts = collectRecordSearchableText(options.store, record, options.includeThinking)

    for (const searchable of searchableParts) {
      const haystack = normalizeSearchValue(searchable.text)
      let from = 0
      let occurrence = 0
      while (from < haystack.length) {
        const index = haystack.indexOf(needle, from)
        if (index === -1) break
        const end = index + query.length
        matches.push({
          id: `${messageId}:${searchable.partId ?? searchable.partType ?? "info"}:${index}`,
          messageId,
          partId: searchable.partId,
          partType: searchable.partType,
          role: record.role,
          start: index,
          end,
          occurrence,
          preview: buildPreview(searchable.text, index, end),
        })
        occurrence += 1
        from = end > index ? end : index + 1
      }
    }
  }

  return matches
}
