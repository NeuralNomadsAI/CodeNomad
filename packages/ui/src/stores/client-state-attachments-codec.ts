import type { Attachment, AttachmentSource } from "../types/attachment"
import {
  createAttachmentPlaceholderRegex,
  type AttachmentPlaceholderKind,
} from "../lib/attachment-placeholders"
import { createPromptMentionRegex, getAttachmentPromptMentionCandidates } from "../lib/attachment-mentions"

export type RestorableAttachmentSource =
  | { type: "file"; path: string; mime: string; data?: string }
  | { type: "text"; value: string }
  | {
      type: "symbol"
      path: string
      name: string
      kind: number
      range: { start: { line: number; char: number }; end: { line: number; char: number } }
    }
  | { type: "agent"; name: string }

export interface RestorableAttachment {
  id: string
  type: Attachment["type"]
  display: string
  url: string
  filename: string
  mediaType: string
  source: RestorableAttachmentSource
}

export interface AttachmentCodecBudget {
  attachmentsRemaining: number
  metadataCharactersRemaining: number
  fileDataCharactersRemaining: number
}

const MAX_ATTACHMENT_SESSIONS_PER_TAB = 24
const MAX_ATTACHMENTS_PER_SESSION = 8
const MAX_ATTACHMENTS_TOTAL = 64
const MAX_ATTACHMENT_METADATA_CHARACTERS = 24 * 1024
const MAX_FILE_DATA_BYTES = 64 * 1024
const MAX_FILE_DATA_CHARACTERS = 96 * 1024
const MAX_ID_LENGTH = 512
const MAX_DISPLAY_LENGTH = 1024
const MAX_PATH_LENGTH = 4096
const MAX_MIME_LENGTH = 256
const MAX_TEXT_LENGTH = 24 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isSafeKey(value: string): boolean {
  return value !== "__proto__" && value !== "constructor" && value !== "prototype"
}

function takeString(
  value: unknown,
  maxLength: number,
  budget: AttachmentCodecBudget,
  allowEmpty = false,
): string | undefined {
  if (typeof value !== "string" || value.length > maxLength || value.length > budget.metadataCharactersRemaining) {
    return undefined
  }
  if (!allowEmpty && value.trim().length === 0) return undefined
  budget.metadataCharactersRemaining -= value.length
  return value
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + chunkSize, bytes.length)))
  }
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const result = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) result[index] = binary.charCodeAt(index)
  return result
}

function normalizeBase64(value: unknown): string | undefined {
  if (value instanceof Uint8Array) {
    if (value.byteLength > MAX_FILE_DATA_BYTES) return undefined
    return bytesToBase64(value)
  }
  if (typeof value !== "string" || value.length > MAX_FILE_DATA_CHARACTERS) return undefined
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return undefined
  try {
    if (base64ToBytes(value).byteLength > MAX_FILE_DATA_BYTES) return undefined
  } catch {
    return undefined
  }
  return value
}

function dataUrlPayload(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const match = value.match(/^data:[^;,]+;base64,([A-Za-z0-9+/]*={0,2})$/)
  return match?.[1]
}

function takeFileData(value: unknown, url: unknown, budget: AttachmentCodecBudget): string | undefined {
  const rawData = dataUrlPayload(url) ?? value
  if (rawData === undefined) return undefined
  const data = normalizeBase64(rawData)
  if (data === undefined || data.length > budget.fileDataCharactersRemaining) return undefined
  budget.fileDataCharactersRemaining -= data.length
  return data
}

function takePosition(value: unknown): { line: number; char: number } | undefined {
  if (!isRecord(value)) return undefined
  if (!Number.isSafeInteger(value.line) || Number(value.line) < 0) return undefined
  if (!Number.isSafeInteger(value.char) || Number(value.char) < 0) return undefined
  return { line: Number(value.line), char: Number(value.char) }
}

function normalizeSource(
  value: unknown,
  rawUrl: unknown,
  budget: AttachmentCodecBudget,
): RestorableAttachmentSource | undefined {
  if (!isRecord(value)) return undefined
  if (value.type === "file") {
    const path = takeString(value.path, MAX_PATH_LENGTH, budget)
    const mime = takeString(value.mime, MAX_MIME_LENGTH, budget)
    if (path === undefined || mime === undefined) return undefined
    const hasData = value.data !== undefined || dataUrlPayload(rawUrl) !== undefined
    const data = takeFileData(value.data, rawUrl, budget)
    if (hasData && data === undefined) return undefined
    return data === undefined ? { type: "file", path, mime } : { type: "file", path, mime, data }
  }
  if (value.type === "text") {
    const text = takeString(value.value, MAX_TEXT_LENGTH, budget, true)
    return text === undefined ? undefined : { type: "text", value: text }
  }
  if (value.type === "agent") {
    const name = takeString(value.name, MAX_DISPLAY_LENGTH, budget)
    return name === undefined ? undefined : { type: "agent", name }
  }
  if (value.type !== "symbol" || !isRecord(value.range)) return undefined

  const path = takeString(value.path, MAX_PATH_LENGTH, budget)
  const name = takeString(value.name, MAX_DISPLAY_LENGTH, budget)
  const start = takePosition(value.range.start)
  const end = takePosition(value.range.end)
  if (path === undefined || name === undefined || !Number.isSafeInteger(value.kind) || !start || !end) return undefined
  return { type: "symbol", path, name, kind: Number(value.kind), range: { start, end } }
}

function normalizeAttachment(value: unknown, budget: AttachmentCodecBudget): RestorableAttachment | undefined {
  if (!isRecord(value) || budget.attachmentsRemaining <= 0) return undefined
  if (value.type !== "file" && value.type !== "text" && value.type !== "symbol" && value.type !== "agent") {
    return undefined
  }

  const nextBudget = { ...budget }
  const id = takeString(value.id, MAX_ID_LENGTH, nextBudget)
  const display = takeString(value.display, MAX_DISPLAY_LENGTH, nextBudget)
  const filename = takeString(value.filename, MAX_PATH_LENGTH, nextBudget)
  const mediaType = takeString(value.mediaType, MAX_MIME_LENGTH, nextBudget)
  const source = normalizeSource(value.source, value.url, nextBudget)
  if (id === undefined || display === undefined || filename === undefined || mediaType === undefined || !source) {
    return undefined
  }
  if (source.type !== value.type) return undefined

  const rawUrl = typeof value.url === "string" && !value.url.startsWith("data:") ? value.url : ""
  const url = takeString(rawUrl, MAX_PATH_LENGTH, nextBudget, true)
  if (url === undefined) return undefined
  nextBudget.attachmentsRemaining -= 1
  Object.assign(budget, nextBudget)
  return { id, type: value.type, display, url, filename, mediaType, source }
}

function getDraftPlaceholder(
  value: unknown,
): { kind: AttachmentPlaceholderKind; counter: string } | undefined {
  if (!isRecord(value) || typeof value.display !== "string" || value.display.length > MAX_DISPLAY_LENGTH) return undefined
  const match = value.display.match(/(pasted|image)\s*#\s*(\d+)/i)
  if (match?.[1] && match[2]) {
    return { kind: match[1].toLowerCase() === "image" ? "image" : "pasted", counter: match[2] }
  }
  return undefined
}

function removeAttachmentPromptTokens(draft: string, attachment: unknown): string {
  const placeholder = getDraftPlaceholder(attachment)
  if (placeholder) {
    return draft.replace(createAttachmentPlaceholderRegex(placeholder.kind, placeholder.counter), "")
  }

  let nextDraft = draft
  for (const candidate of getAttachmentPromptMentionCandidates(attachment)) {
    nextDraft = nextDraft.replace(createPromptMentionRegex(candidate, { global: true }), "")
  }
  return nextDraft
}

export function createAttachmentCodecBudget(): AttachmentCodecBudget {
  return {
    attachmentsRemaining: MAX_ATTACHMENTS_TOTAL,
    metadataCharactersRemaining: MAX_ATTACHMENT_METADATA_CHARACTERS,
    fileDataCharactersRemaining: MAX_FILE_DATA_CHARACTERS,
  }
}

export function normalizeRestorableAttachmentRecord(
  value: unknown,
  drafts: Record<string, string>,
  budget: AttachmentCodecBudget,
): { attachments: Record<string, RestorableAttachment[]>; drafts: Record<string, string> } | null {
  if (!isRecord(value)) return null
  const attachments: Record<string, RestorableAttachment[]> = Object.create(null)
  const nextDrafts = { ...drafts }
  let sessionCount = 0

  for (const [sessionId, rawAttachments] of Object.entries(value)) {
    if (!isSafeKey(sessionId) || sessionId.length === 0 || sessionId.length > MAX_ID_LENGTH || !Array.isArray(rawAttachments)) {
      continue
    }
    const canPersistSession = sessionCount < MAX_ATTACHMENT_SESSIONS_PER_TAB
    if (canPersistSession) sessionCount += 1
    const normalized: RestorableAttachment[] = []
    for (const rawAttachment of rawAttachments) {
      const attachment = canPersistSession && normalized.length < MAX_ATTACHMENTS_PER_SESSION
        ? normalizeAttachment(rawAttachment, budget)
        : undefined
      if (attachment) {
        normalized.push(attachment)
      } else if (nextDrafts[sessionId]) {
        nextDrafts[sessionId] = removeAttachmentPromptTokens(nextDrafts[sessionId], rawAttachment)
      }
    }
    if (normalized.length > 0) attachments[sessionId] = normalized
  }
  return { attachments, drafts: nextDrafts }
}

export function serializeDraftAttachments(
  drafts: Record<string, string>,
  attachments: Record<string, Attachment[]>,
): { drafts: Record<string, string>; attachments: Record<string, RestorableAttachment[]> } {
  return normalizeRestorableAttachmentRecord(attachments, drafts, createAttachmentCodecBudget())
    ?? { drafts: { ...drafts }, attachments: {} }
}

export function hydrateRestorableAttachment(value: RestorableAttachment): Attachment | null {
  let source: AttachmentSource
  let url = value.url
  if (value.source.type === "file") {
    let data: Uint8Array | undefined
    if (value.source.data !== undefined) {
      try {
        data = base64ToBytes(value.source.data)
      } catch {
        return null
      }
      if (!url) url = `data:${value.source.mime};base64,${value.source.data}`
    }
    source = { type: "file", path: value.source.path, mime: value.source.mime, data }
  } else if (value.source.type === "text") {
    source = value.source
    if (!url) url = `data:text/plain;base64,${bytesToBase64(new TextEncoder().encode(value.source.value))}`
  } else {
    source = value.source
  }
  return { ...value, url, source }
}
