import { LOCAL_BACKEND_ID } from "../lib/backend-identity"

// Unsupported-plugin recovery notices already shown in this tab, including across reloads.
// The plugin belongs to the OpenCode connection, not a project: one notice covers all.
const STORAGE_KEY = "codenomad.pendingRecoveryNotices"
const UNSUPPORTED = "unsupported"
const unsupportedKey = (backendId: string) => backendId === LOCAL_BACKEND_ID ? UNSUPPORTED : `${UNSUPPORTED}:${JSON.stringify(backendId)}`

function storage(): Storage | undefined {
  try { return typeof window === "undefined" ? undefined : window.sessionStorage } catch { return undefined }
}

const shown = new Map<string, object>((() => {
  try {
    const stored: unknown = JSON.parse(storage()?.getItem(STORAGE_KEY) ?? "[]")
    if (!Array.isArray(stored)) return []
    return stored.flatMap((entry): [string, object][] => {
      const key = Array.isArray(entry) && typeof entry[0] === "string" ? entry[0] : typeof entry === "string" ? entry : undefined
      return key && (key === UNSUPPORTED || key.startsWith(`${UNSUPPORTED}:`)) ? [[key, {}]] : []
    })
  } catch { return [] }
})())

function persist(): void {
  try { storage()?.setItem(STORAGE_KEY, JSON.stringify([...shown.keys()])) } catch { /* Deduplication still holds for this page. */ }
}

/** True the first time an unsupported-plugin notice is claimed for `backendId`, until recovery succeeds. */
export function claimUnsupportedPendingRecoveryNotice(backendId = LOCAL_BACKEND_ID): boolean {
  const key = unsupportedKey(backendId)
  if (shown.has(key)) return false
  shown.set(key, {})
  persist()
  return true
}

/** Only a complete recovery started after the notice was claimed can re-arm it. */
export function captureUnsupportedPendingRecoveryNotice(backendId = LOCAL_BACKEND_ID) {
  const key = unsupportedKey(backendId)
  const claimed = shown.get(key)
  return {
    release() {
      if (claimed !== undefined && shown.get(key) === claimed && shown.delete(key)) persist()
    },
  }
}
