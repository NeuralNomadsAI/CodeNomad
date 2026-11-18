import type { PendingRecoveryCause } from "./pending-recovery-cause"

// Incomplete-recovery notices already shown in this browser tab. Kept in session
// storage so reconnects, re-added projects and page reloads never repeat one.
const STORAGE_KEY = "codenomad.pendingRecoveryNotices"
// The plugin is provided per OpenCode connection, not per project: one notice covers all.
const UNSUPPORTED = "unsupported"

function storage(): Storage | undefined {
  try { return typeof window === "undefined" ? undefined : window.sessionStorage } catch { return undefined }
}

const shown = new Set<string>((() => {
  try {
    const stored: unknown = JSON.parse(storage()?.getItem(STORAGE_KEY) ?? "[]")
    return Array.isArray(stored) ? stored.filter((key): key is string => typeof key === "string") : []
  } catch { return [] }
})())

function persist(): void {
  try { storage()?.setItem(STORAGE_KEY, JSON.stringify([...shown])) } catch { /* Deduplication still holds for this page. */ }
}

/** One notice per project and described cause; the unavailable plugin is one notice for every project. */
export function pendingRecoveryNoticeKey(project: string, cause: PendingRecoveryCause, message: string): string {
  return cause.kind === "unsupported" ? UNSUPPORTED : `${project}\n${message}`
}

/** True the first time a notice is claimed, until its project recovers. */
export function claimPendingRecoveryNotice(key: string): boolean {
  if (shown.has(key)) return false
  shown.add(key)
  persist()
  return true
}

/** A complete recovery of `project` proves the plugin answers and re-arms that project's notices. */
export function releasePendingRecoveryNotices(project: string): void {
  let changed = shown.delete(UNSUPPORTED)
  for (const key of shown) if (key.startsWith(`${project}\n`)) changed = shown.delete(key) || changed
  if (changed) persist()
}
