import { createHash } from "node:crypto"
import { USER_FILE_BASE64, USER_FILE_BYTES, USER_FILE_COUNT } from "./user-file-contract"
export * from "./user-file-contract"

export const userFileDigest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

export function readInlineUserFile(value: unknown): Buffer | "too_large" | undefined {
  if (typeof value !== "string") return
  if (value.length > USER_FILE_BASE64) return "too_large"
  const bytes = Buffer.from(value, "base64")
  if (bytes.length > USER_FILE_BYTES) return "too_large"
  if (bytes.toString("base64") === value) return bytes
}

export function userFileLabel(file: { name?: unknown; mime?: unknown }, digest?: string) {
  const name = typeof file.name === "string" ? file.name.split(/[\\/]/).at(-1) : undefined
  return {
    ...(name ? { name: Array.from(name).slice(0, 1024).join("") } : {}),
    mime: typeof file.mime === "string" && file.mime !== "" ? Array.from(file.mime).slice(0, 256).join("") : "application/octet-stream",
    source: digest ? { type: "deferred", sha256: digest } : { type: "unavailable" },
  }
}

export function hasOnlyUserFileReferences(message: { type: string; files?: unknown }) {
  if (message.type !== "user" || message.files === undefined) return true
  return Array.isArray(message.files) && message.files.length <= USER_FILE_COUNT && message.files.every(file =>
    file && typeof file === "object" && Object.keys(file).every(key => ["name", "mime", "source"].includes(key))
    && (file.name === undefined || typeof file.name === "string") && typeof file.mime === "string"
    && file.source && (file.source.type === "unavailable" && Object.keys(file.source).length === 1
      || file.source.type === "deferred" && Object.keys(file.source).length === 2
      && typeof file.source.sha256 === "string" && /^[0-9a-f]{64}$/.test(file.source.sha256)))
}

export function isProjectedInbox(envelope: unknown): boolean {
  const value = envelope as { type?: string; event?: { type?: string; data?: { item?: { type?: string; payload?: { files?: unknown } } } } }
  if (value?.type !== "instance.event" || value.event?.type !== "session.inbox.enqueued") return false
  const item = value.event.data?.item, files = item?.payload?.files
  return item?.type === "user" && Array.isArray(files) && files.length > 0 && hasOnlyUserFileReferences({ type: "user", files })
}

export function projectInboxUserFiles<T>(envelope: T): T {
  const event = envelope as { type?: string; event?: { type?: string; data?: { item?: unknown } } }
  if (event?.type !== "instance.event" || event.event?.type !== "session.inbox.enqueued") return envelope
  const item = event.event.data?.item as { type?: string; payload?: { files?: unknown[] } } | undefined
  if (item?.type !== "user" || !Array.isArray(item.payload?.files)) return envelope
  if (hasOnlyUserFileReferences({ type: "user", files: item.payload.files })) return envelope
  const files = item.payload.files.slice(0, USER_FILE_COUNT).map(input => {
    const file = input as { name?: unknown; mime?: unknown; data?: unknown; source?: { type?: unknown } } | null
    const bytes = file?.source?.type === "uri" ? undefined : readInlineUserFile(file?.data)
    return userFileLabel(file ?? {}, Buffer.isBuffer(bytes) ? userFileDigest(bytes) : undefined)
  })
  return {
    ...event, event: { ...event.event, data: { ...event.event.data, item: { ...item, payload: { ...item.payload, files } } } },
  } as T
}
