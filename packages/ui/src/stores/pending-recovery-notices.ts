import type { PendingRecoveryCause } from "./pending-recovery-cause"

// Recovery incidents already reported in this tab, including across reloads.
const STORAGE_KEY = "codenomad.pendingRecoveryNotices"
// The plugin is provided per OpenCode connection, not per project: one notice covers all.
const UNSUPPORTED = "unsupported"

const PROJECT_PREFIX = "project:"
const projectKey = (project: string) => `${PROJECT_PREFIX}${JSON.stringify(project)}`

function storage(): Storage | undefined {
  try { return typeof window === "undefined" ? undefined : window.sessionStorage } catch { return undefined }
}

const shown = new Set<string>((() => {
  try {
    const stored: unknown = JSON.parse(storage()?.getItem(STORAGE_KEY) ?? "[]")
    if (!Array.isArray(stored)) return []
    // Collapse saved project + message claims to the project alone.
    return stored.flatMap((key) => {
      if (typeof key !== "string") return []
      if (key === UNSUPPORTED) return [key]
      const separator = key.indexOf("\n")
      if (separator >= 0) return [projectKey(key.slice(0, separator))]
      return key.startsWith(PROJECT_PREFIX) ? [key] : []
    })
  } catch { return [] }
})())

function persist(): void {
  try { storage()?.setItem(STORAGE_KEY, JSON.stringify([...shown])) } catch { /* Deduplication still holds for this page. */ }
}

/** True the first time a notice is claimed, until its project recovers. */
export function claimPendingRecoveryNotice(project: string, kind: PendingRecoveryCause["kind"]): boolean {
  const key = kind === "unsupported" ? UNSUPPORTED : projectKey(project)
  if (shown.has(key)) return false
  shown.add(key)
  persist()
  return true
}

/** A complete recovery of `project` proves the plugin answers and re-arms that project's notices. */
export function releasePendingRecoveryNotices(project: string): void {
  const plugin = shown.delete(UNSUPPORTED)
  if (shown.delete(projectKey(project)) || plugin) persist()
}
