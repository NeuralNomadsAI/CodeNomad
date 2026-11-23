export interface WorkspaceFileDraft {
  key: string
  fingerprint: string
  text: string
}

const MAX_DRAFTS = 32
const MAX_BYTES = 256 * 1024
const utf8 = new TextEncoder()

export function normalizeWorkspaceFileDrafts(value: unknown): WorkspaceFileDraft[] {
  if (!Array.isArray(value)) return []
  const drafts = new Map<string, WorkspaceFileDraft>()
  let bytes = 2
  for (const item of value.slice(0, MAX_DRAFTS)) {
    if (!item || typeof item !== "object") continue
    const { key, fingerprint, text } = item
    if (typeof key !== "string" || !key.length || key.length > 16 * 1024 || drafts.has(key)
      || typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint)
      || typeof text !== "string" || text.length > MAX_BYTES) continue
    const entry = { key, fingerprint, text }
    const size = utf8.encode(JSON.stringify(entry)).length + 1
    if (bytes + size > MAX_BYTES) continue
    bytes += size
    drafts.set(key, entry)
  }
  return [...drafts.values()]
}
