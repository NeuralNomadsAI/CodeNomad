import type { Attachment, AttachmentSource } from "../types/attachment"

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
const MAX_ID = 512
const MAX_DISPLAY = 1024
const MAX_PATH = 4096
const MAX_MIME = 256

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const isSafeKey = (value: string) =>
  value !== "__proto__" && value !== "constructor" && value !== "prototype"

function takeString(value: unknown, max: number, allowEmpty = false) {
  if (typeof value !== "string" || value.length > max) return
  if (!allowEmpty && value.trim().length === 0) return
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

function takeFileData(value: unknown, url: unknown): string | undefined {
  const raw = dataUrlPayload(url) ?? value
  const data = raw instanceof Uint8Array ? bytesToBase64(raw) : raw
  return validBase64(data) ? data : undefined
}

function takePosition(value: unknown): Position | undefined {
  if (!isRecord(value) || !Number.isSafeInteger(value.line) || Number(value.line) < 0) return
  if (!Number.isSafeInteger(value.char) || Number(value.char) < 0) return
  return { line: Number(value.line), char: Number(value.char) }
}

function normalizeSource(
  value: unknown,
  url: unknown,
): RestorableAttachmentSource | undefined {
  if (!isRecord(value)) return
  if (value.type === "text") {
    return typeof value.value === "string" ? { type: "text", value: value.value } : undefined
  }
  if (value.type === "agent") {
    const name = takeString(value.name, MAX_DISPLAY)
    return name === undefined ? undefined : { type: "agent", name }
  }

  const path = takeString(value.path, MAX_PATH)
  if (value.type === "file") {
    const mime = takeString(value.mime, MAX_MIME)
    if (path === undefined || mime === undefined) return
    const rawData = dataUrlPayload(url) ?? value.data
    const data = takeFileData(value.data, url)
    if (rawData !== undefined && data === undefined) return
    return data === undefined ? { type: "file", path, mime } : { type: "file", path, mime, data }
  }
  if (value.type !== "symbol" || !isRecord(value.range)) return
  const name = takeString(value.name, MAX_DISPLAY)
  const start = takePosition(value.range.start)
  const end = takePosition(value.range.end)
  if (path === undefined || name === undefined || !Number.isSafeInteger(value.kind) || !start || !end) return
  return { type: "symbol", path, name, kind: Number(value.kind), range: { start, end } }
}

function normalizeAttachment(value: unknown): RestorableAttachment | undefined {
  if (!isRecord(value)) return
  if (!["file", "text", "symbol", "agent"].includes(String(value.type))) return

  const id = takeString(value.id, MAX_ID)
  const display = takeString(value.display, MAX_DISPLAY)
  const filename = takeString(value.filename, MAX_PATH)
  const mediaType = takeString(value.mediaType, MAX_MIME)
  const source = normalizeSource(value.source, value.url)
  const rawUrl = typeof value.url === "string" && !value.url.startsWith("data:") ? value.url : ""
  const url = takeString(rawUrl, MAX_PATH, true)
  if (
    !id || !display || !filename || !mediaType || !source ||
    source.type !== value.type || url === undefined
  ) return

  return { id, type: value.type as Attachment["type"], display, url, filename, mediaType, source }
}

export function normalizeRestorableAttachmentRecord(
  value: unknown,
  drafts: Record<string, string>,
  prioritySessionIds: readonly string[] = [],
): { attachments: Record<string, RestorableAttachment[]>; drafts: Record<string, string> } | null {
  if (!isRecord(value)) return null
  const attachments: Record<string, RestorableAttachment[]> = Object.create(null)
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
    const normalized: RestorableAttachment[] = []
    for (const raw of rawAttachments) {
      const attachment = normalizeAttachment(raw)
      if (attachment) normalized.push(attachment)
    }
    if (normalized.length) attachments[sessionId] = normalized
  }
  return { attachments, drafts: { ...drafts } }
}

export function serializeDraftAttachments(
  drafts: Record<string, string>,
  attachments: Record<string, Attachment[]>,
  prioritySessionIds: readonly string[] = [],
) {
  const normalized = normalizeRestorableAttachmentRecord(attachments, drafts, prioritySessionIds)
  if (!normalized || Object.entries(attachments).some(([sessionId, values]) =>
    values.length !== (normalized.attachments[sessionId]?.length ?? 0))) {
    throw new Error("Draft attachments could not be persisted safely")
  }
  return normalized
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
