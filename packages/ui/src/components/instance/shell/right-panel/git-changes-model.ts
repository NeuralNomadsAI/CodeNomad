import type { VcsFileStatus } from "@opencode/client"
import type { WorktreeGitStatusEntry } from "../../../../../../server/src/api-types"

import type { GitChangeEntry, GitChangeListItem, GitChangeSection, GitChangeStatus } from "./types"

function normalizeGitChangePath(path: unknown): string {
  if (typeof path !== "string") return ""
  const normalized = path.replace(/\\+/g, "/").replace(/^\.\//, "").trim()
  return normalized
}

export function normalizeGitChangeStatus(status: unknown): GitChangeStatus {
  return typeof status === "string" && status.trim().length > 0 ? status : "modified"
}

export function adaptSdkGitStatusEntry(entry: VcsFileStatus): GitChangeEntry {
  return {
    path: normalizeGitChangePath(entry.file),
    originalPath: null,
    additions: entry.additions,
    deletions: entry.deletions,
    status: normalizeGitChangeStatus(entry.status),
  }
}

export function adaptSdkGitStatusEntries(
  entries: VcsFileStatus[] | null | undefined,
  details?: WorktreeGitStatusEntry[] | null,
): GitChangeEntry[] {
  const detailsByPath = new Map(
    (details ?? [])
      .map((entry) => {
        const path = normalizeGitChangePath(entry.path)
        return path ? [{ ...entry, path }, path] : null
      })
      .filter((entry): entry is [WorktreeGitStatusEntry, string] => Boolean(entry))
      .map(([entry, path]) => [path, entry] as const),
  )
  const adaptedByPath = new Map<string, GitChangeEntry>()

  for (const entry of entries ?? []) {
    const adapted = adaptSdkGitStatusEntry(entry)
    if (!adapted.path) continue
    const detail = detailsByPath.get(adapted.path)
    // Local Git supplies the complete staged/unstaged inventory used for edits.
    // Native VCS can still report an older snapshot after checkout creation or
    // movement; never resurrect absent files once local details are available.
    if (details && !detail) continue
    adaptedByPath.set(adapted.path, {
      ...adapted,
      originalPath: detail?.originalPath ? normalizeGitChangePath(detail.originalPath) : adapted.originalPath ?? null,
      stagedStatus: detail?.stagedStatus ?? null,
      unstagedStatus: detail?.unstagedStatus ?? null,
      stagedAdditions: detail?.stagedAdditions ?? 0,
      stagedDeletions: detail?.stagedDeletions ?? 0,
      unstagedAdditions: detail?.unstagedAdditions ?? 0,
      unstagedDeletions: detail?.unstagedDeletions ?? 0,
      ...(detail?.unstagedWhitespaceOnly ? { unstagedWhitespaceOnly: true } : {}),
    })
  }

  for (const detail of details ?? []) {
    const normalizedPath = normalizeGitChangePath(detail.path)
    if (!normalizedPath || adaptedByPath.has(normalizedPath)) continue
    adaptedByPath.set(normalizedPath, {
      path: normalizedPath,
      originalPath: detail.originalPath ? normalizeGitChangePath(detail.originalPath) : null,
      additions: 0,
      deletions: 0,
      status: detail.unstagedStatus ?? detail.stagedStatus ?? "modified",
      stagedStatus: detail.stagedStatus,
      unstagedStatus: detail.unstagedStatus,
      stagedAdditions: detail.stagedAdditions,
      stagedDeletions: detail.stagedDeletions,
      unstagedAdditions: detail.unstagedAdditions,
      unstagedDeletions: detail.unstagedDeletions,
      ...(detail.unstagedWhitespaceOnly ? { unstagedWhitespaceOnly: true } : {}),
    })
  }

  return Array.from(adaptedByPath.values()).filter((entry) => entry.path.length > 0)
}

/**
 * Omits worktree changes Git reports as whitespace/line-ending only. Staged rows
 * always stay visible so a commit never includes changes the list does not show.
 */
export function hideWhitespaceOnlyChanges(entries: GitChangeEntry[] | null, hide: boolean): GitChangeEntry[] | null {
  if (!entries || !hide) return entries
  return entries.flatMap((entry) => {
    if (!entry.unstagedWhitespaceOnly) return [entry]
    return entry.stagedStatus ? [{ ...entry, unstagedStatus: null, unstagedAdditions: 0, unstagedDeletions: 0 }] : []
  })
}

export function buildGitChangeListItemId(section: GitChangeSection, path: string): string {
  return `${section}:${path}`
}

function sameFields(a: object, b: object): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key =>
    Object.prototype.hasOwnProperty.call(b, key) && (a as Record<string, unknown>)[key] === (b as Record<string, unknown>)[key])
}

/**
 * Keeps the identity of unchanged status records across refreshes. Returns
 * `previous` itself when `next` holds the same records in the same order, so
 * an unchanged refresh publishes nothing; otherwise `next`, where every record
 * whose fields all match its previous record (by `key`) is that previous object,
 * so keyed lists only replace the rows that changed.
 */
export function reuseUnchanged<T extends object>(previous: T[] | null | undefined, next: T[], key: (value: T) => string): T[] {
  if (!previous?.length) return previous && next.length === 0 ? previous : next
  const byKey = new Map(previous.map(value => [key(value), value]))
  let identical = previous.length === next.length
  const reused = next.map((value, index) => {
    const old = byKey.get(key(value))
    const kept = old && sameFields(old, value) ? old : value
    if (kept !== previous[index]) identical = false
    return kept
  })
  return identical ? previous : reused
}

function splitGitChangePath(path: string) {
  const normalized = normalizeGitChangePath(path)
  const lastSlash = normalized.lastIndexOf("/")
  if (lastSlash === -1) {
    return { displayName: normalized, parentPath: "" }
  }
  return {
    displayName: normalized.slice(lastSlash + 1),
    parentPath: normalized.slice(0, lastSlash),
  }
}

export function buildGitChangeListItems(entries: GitChangeEntry[] | null | undefined): GitChangeListItem[] {
  if (!Array.isArray(entries)) return []

  const items: GitChangeListItem[] = []
  for (const entry of entries) {
    const pathParts = splitGitChangePath(entry.path)
    if (entry.stagedStatus) {
      items.push({
        id: buildGitChangeListItemId("staged", entry.path),
        path: entry.path,
        originalPath: entry.originalPath ?? null,
        section: "staged",
        status: entry.stagedStatus,
        additions: entry.stagedAdditions ?? 0,
        deletions: entry.stagedDeletions ?? 0,
        displayName: pathParts.displayName,
        parentPath: pathParts.parentPath,
      })
    }
    if (entry.unstagedStatus) {
      items.push({
        id: buildGitChangeListItemId("unstaged", entry.path),
        path: entry.path,
        originalPath: entry.originalPath ?? null,
        section: "unstaged",
        status: entry.unstagedStatus,
        additions: entry.unstagedAdditions ?? entry.additions,
        deletions: entry.unstagedDeletions ?? entry.deletions,
        displayName: pathParts.displayName,
        parentPath: pathParts.parentPath,
      })
    }
    if (!entry.stagedStatus && !entry.unstagedStatus) {
      items.push({
        id: buildGitChangeListItemId("unstaged", entry.path),
        path: entry.path,
        originalPath: entry.originalPath ?? null,
        section: "unstaged",
        status: entry.status,
        additions: entry.additions,
        deletions: entry.deletions,
        displayName: pathParts.displayName,
        parentPath: pathParts.parentPath,
      })
    }
  }

  return items.sort((a, b) => {
    if (a.section !== b.section) return a.section.localeCompare(b.section)
    return a.path.localeCompare(b.path)
  })
}
