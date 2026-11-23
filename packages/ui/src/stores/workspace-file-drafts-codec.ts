export interface WorkspaceFileDraft {
  key: string
  fingerprint: string
  text: string
}

const MAX_DRAFTS = 32
export const MAX_FILE_DRAFT_BYTES = 256 * 1024
const utf8 = new TextEncoder()
const unpairedSurrogate = /\p{Surrogate}/u

export function normalizeWorkspaceFileDrafts(value: unknown): WorkspaceFileDraft[] {
  if (!Array.isArray(value)) return []
  const drafts = new Map<string, WorkspaceFileDraft>()
  let bytes = 2
  for (const item of value.slice(0, MAX_DRAFTS)) {
    if (!item || typeof item !== "object") continue
    const { key, fingerprint, text } = item
    if (typeof key !== "string" || !key.length || key.length > 16 * 1024 || drafts.has(key)
      || typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint)
      || typeof text !== "string" || text.length > MAX_FILE_DRAFT_BYTES
      || unpairedSurrogate.test(key) || unpairedSurrogate.test(text)) continue
    const entry = { key, fingerprint, text }
    const size = utf8.encode(JSON.stringify(entry)).length + (drafts.size ? 1 : 0)
    if (bytes + size > MAX_FILE_DRAFT_BYTES) continue
    bytes += size
    drafts.set(key, entry)
  }
  return [...drafts.values()]
}

export function changeWorkspaceFileDrafts(drafts: WorkspaceFileDraft[], key: string, value: Omit<WorkspaceFileDraft, "key"> | null) {
  if (!key || key.length > 16 * 1024) return null
  const remaining = drafts.filter(draft => draft.key !== key)
  if (!value) return remaining
  const next = normalizeWorkspaceFileDrafts([...remaining, { key, fingerprint: value.fingerprint, text: value.text }])
  return next.some(draft => draft.key === key) ? next : null
}
