import type { PendingRecoveryCause } from "./pending-recovery-cause"
import { normalizeWorkspacePath } from "./app-session-reconciliation"

// Recovery incidents already reported in this tab, including across reloads.
const STORAGE_KEY = "codenomad.pendingRecoveryNotices"
// The plugin is provided per OpenCode connection, not per project: one notice covers all.
const UNSUPPORTED = "unsupported"

const PROJECT_PREFIX = "project:"
const projectKey = (project: string) => `${PROJECT_PREFIX}${JSON.stringify(project)}`

function storage(): Storage | undefined {
  try { return typeof window === "undefined" ? undefined : window.sessionStorage } catch { return undefined }
}

const shown = new Map<string, string[]>((() => {
  try {
    const stored: unknown = JSON.parse(storage()?.getItem(STORAGE_KEY) ?? "[]")
    if (!Array.isArray(stored)) return []
    // Collapse saved project + message claims to the project alone.
    return stored.flatMap((entry): [string, string[]][] => {
      if (Array.isArray(entry) && typeof entry[0] === "string" && Array.isArray(entry[1])) {
        return [[entry[0], entry[1].filter((directory): directory is string => typeof directory === "string")]]
      }
      if (typeof entry !== "string") return []
      const separator = entry.indexOf("\n")
      if (separator >= 0) return [[projectKey(entry.slice(0, separator)), []]]
      return entry === UNSUPPORTED || entry.startsWith(PROJECT_PREFIX) ? [[entry, []]] : []
    })
  } catch { return [] }
})())

function persist(): void {
  try { storage()?.setItem(STORAGE_KEY, JSON.stringify([...shown])) } catch { /* Deduplication still holds for this page. */ }
}

/** True the first time a notice is claimed, until its project recovers. */
export function claimPendingRecoveryNotice(project: string, cause: PendingRecoveryCause): boolean {
  const key = cause.kind === "unsupported" ? UNSUPPORTED : projectKey(project)
  if (shown.has(key)) return false
  const directories = cause.kind === "directories" ? [...new Set(cause.directories.map(({ directory }) => directory))] : []
  shown.set(key, directories)
  persist()
  return true
}

/** Only coverage collected after a notice was claimed can re-arm it. */
export function capturePendingRecoveryNotices(project: string) {
  const key = projectKey(project)
  const failed = shown.get(key)
  const plugin = shown.get(UNSUPPORTED)
  const current = () => failed !== undefined && shown.get(key) === failed
  const missing = (directories: readonly string[]) => {
    if (!current() || !failed) return []
    const covered = new Set(directories.map(normalizeWorkspacePath))
    return failed.filter(directory => !covered.has(normalizeWorkspacePath(directory)))
  }
  return {
    current,
    missing,
    release(directories: readonly string[]) {
      let changed = plugin !== undefined && shown.get(UNSUPPORTED) === plugin && shown.delete(UNSUPPORTED)
      if (current() && !missing(directories).length) changed = shown.delete(key) || changed
      if (changed) persist()
    },
  }
}
