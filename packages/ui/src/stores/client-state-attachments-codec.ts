import type { Attachment, AttachmentSource } from "../types/attachment"
import { removeAttachmentPromptTokens } from "../lib/attachment-mentions"

export type RestorableAttachmentSource =
  | { type: "file"; path: string; mime: string; data?: string }
  | { type: "text"; value: string }
  | { type: "agent"; name: string }
  | { type: "symbol"; path: string; name: string; kind: number; range: { start: Position; end: Position } }

interface Position {
  line: number
  char: number
}

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

const MAX_SESSIONS = 24
const MAX_PER_SESSION = 8
const MAX_ATTACHMENTS = 64
const MAX_METADATA = 24 * 1024
const MAX_FILE_BYTES = 64 * 1024
const MAX_FILE_CHARACTERS = 96 * 1024
const MAX_ID = 512
const MAX_DISPLAY = 1024
const MAX_PATH = 4096
const MAX_MIME = 256
const MAX_TEXT = 24 * 1024

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const isSafeKey = (value: string) =>
  value !== "__proto__" && value !== "constructor" && value !== "prototype"

function takeString(value: unknown, max: number, budget: AttachmentCodecBudget, allowEmpty = false) {
  if (
    typeof value !== "string" ||
    value.length > max ||
    value.length > budget.metadataCharactersRemaining
  ) return
  if (!allowEmpty && value.trim().length === 0) return
  budget.metadataCharactersRemaining -= value.length
  return value
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary)
}

const base64ToBytes = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0))

function validBase64(value: unknown): value is string {
  if (typeof value !== "string" || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false
  try {
    base64ToBytes(value)
    return true
  } catch {
    return false
  }
}

const dataUrlPayload = (value: unknown): string | undefined => typeof value === "string"
  ? value.match(/^data:[^;,]+;base64,([A-Za-z0-9+/]*={0,2})$/)?.[1]
  : undefined

function takeFileData(value: unknown, url: unknown, budget: AttachmentCodecBudget): string | undefined {
  const raw = dataUrlPayload(url) ?? value
  if (raw instanceof Uint8Array && raw.byteLength > MAX_FILE_BYTES) return
  const data = raw instanceof Uint8Array ? bytesToBase64(raw) : raw
  if (
    !validBase64(data) ||
    base64ToBytes(data).byteLength > MAX_FILE_BYTES ||
    data.length > MAX_FILE_CHARACTERS ||
    data.length > budget.fileDataCharactersRemaining
  ) return
  budget.fileDataCharactersRemaining -= data.length
  return data
}

function takePosition(value: unknown): Position | undefined {
  if (!isRecord(value) || !Number.isSafeInteger(value.line) || Number(value.line) < 0) return
  if (!Number.isSafeInteger(value.char) || Number(value.char) < 0) return
  return { line: Number(value.line), char: Number(value.char) }
}

function normalizeSource(
  value: unknown,
  url: unknown,
  budget: AttachmentCodecBudget,
): RestorableAttachmentSource | undefined {
  if (!isRecord(value)) return
  if (value.type === "text") {
    const text = takeString(value.value, MAX_TEXT, budget, true)
    return text === undefined ? undefined : { type: "text", value: text }
  }
  if (value.type === "agent") {
    const name = takeString(value.name, MAX_DISPLAY, budget)
    return name === undefined ? undefined : { type: "agent", name }
  }

  const path = takeString(value.path, MAX_PATH, budget)
  if (value.type === "file") {
    const mime = takeString(value.mime, MAX_MIME, budget)
    if (path === undefined || mime === undefined) return
    const rawData = dataUrlPayload(url) ?? value.data
    const data = takeFileData(value.data, url, budget)
    const pathBacked = typeof url === "string" && url.length > 0 && !url.startsWith("data:")
    const validPathData = rawData instanceof Uint8Array || validBase64(rawData)
    if (rawData !== undefined && data === undefined && (!pathBacked || !validPathData)) return
    return data === undefined ? { type: "file", path, mime } : { type: "file", path, mime, data }
  }
  if (value.type !== "symbol" || !isRecord(value.range)) return
  const name = takeString(value.name, MAX_DISPLAY, budget)
  const start = takePosition(value.range.start)
  const end = takePosition(value.range.end)
  if (path === undefined || name === undefined || !Number.isSafeInteger(value.kind) || !start || !end) return
  return { type: "symbol", path, name, kind: Number(value.kind), range: { start, end } }
}

function normalizeAttachment(value: unknown, budget: AttachmentCodecBudget): RestorableAttachment | undefined {
  if (!isRecord(value) || budget.attachmentsRemaining <= 0) return
  if (!["file", "text", "symbol", "agent"].includes(String(value.type))) return

  const next = { ...budget }
  const id = takeString(value.id, MAX_ID, next)
  const display = takeString(value.display, MAX_DISPLAY, next)
  const filename = takeString(value.filename, MAX_PATH, next)
  const mediaType = takeString(value.mediaType, MAX_MIME, next)
  const source = normalizeSource(value.source, value.url, next)
  const rawUrl = typeof value.url === "string" && !value.url.startsWith("data:") ? value.url : ""
  const url = takeString(rawUrl, MAX_PATH, next, true)
  if (
    !id || !display || !filename || !mediaType || !source ||
    source.type !== value.type || url === undefined
  ) return

  next.attachmentsRemaining -= 1
  Object.assign(budget, next)
  return { id, type: value.type as Attachment["type"], display, url, filename, mediaType, source }
}

export function createAttachmentCodecBudget(): AttachmentCodecBudget {
  return {
    attachmentsRemaining: MAX_ATTACHMENTS,
    metadataCharactersRemaining: MAX_METADATA,
    fileDataCharactersRemaining: MAX_FILE_CHARACTERS,
  }
}

export function normalizeRestorableAttachmentRecord(
  value: unknown,
  drafts: Record<string, string>,
  budget: AttachmentCodecBudget,
  prioritySessionIds: readonly string[] = [],
): { attachments: Record<string, RestorableAttachment[]>; drafts: Record<string, string> } | null {
  if (!isRecord(value)) return null
  const attachments: Record<string, RestorableAttachment[]> = Object.create(null)
  const nextDrafts = { ...drafts }
  let sessions = 0
  const priority = [...new Set(prioritySessionIds)]
  const prioritySet = new Set(priority)
  const entries = [
    ...priority.flatMap((sessionId) => Object.prototype.hasOwnProperty.call(value, sessionId)
      ? [[sessionId, value[sessionId]] as const]
      : []),
    ...Object.entries(value).filter(([sessionId]) => !prioritySet.has(sessionId)),
  ]
  for (const [sessionId, rawAttachments] of entries) {
    if (
      !isSafeKey(sessionId) || !sessionId ||
      sessionId.length > MAX_ID || !Array.isArray(rawAttachments)
    ) continue
    const persist = sessions++ < MAX_SESSIONS
    const normalized: RestorableAttachment[] = []
    for (const raw of rawAttachments) {
      const attachment = persist && normalized.length < MAX_PER_SESSION ? normalizeAttachment(raw, budget) : undefined
      if (attachment) normalized.push(attachment)
      else if (nextDrafts[sessionId]) nextDrafts[sessionId] = removeAttachmentPromptTokens(nextDrafts[sessionId], raw)
    }
    if (normalized.length) attachments[sessionId] = normalized
  }
  return { attachments, drafts: nextDrafts }
}

export function serializeDraftAttachments(
  drafts: Record<string, string>,
  attachments: Record<string, Attachment[]>,
  prioritySessionIds: readonly string[] = [],
) {
  return normalizeRestorableAttachmentRecord(attachments, drafts, createAttachmentCodecBudget(), prioritySessionIds)
    ?? { drafts: { ...drafts }, attachments: {} }
}

export function hydrateRestorableAttachment(value: RestorableAttachment): Attachment | null {
  let source: AttachmentSource
  let url = value.url
  if (value.source.type === "file") {
    try {
      const data = value.source.data === undefined ? undefined : base64ToBytes(value.source.data)
      source = { type: "file", path: value.source.path, mime: value.source.mime, data }
      if (!url && value.source.data) url = `data:${value.source.mime};base64,${value.source.data}`
    } catch {
      return null
    }
  } else {
    source = value.source
    if (value.source.type === "text" && !url) {
      url = `data:text/plain;base64,${bytesToBase64(new TextEncoder().encode(value.source.value))}`
    }
  }
  return { ...value, url, source }
}
