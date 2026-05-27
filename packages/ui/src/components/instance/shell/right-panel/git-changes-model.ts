import type { File as SdkGitFileStatus } from "@opencode-ai/sdk/v2/client"
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

export function adaptSdkGitStatusEntry(entry: SdkGitFileStatus): GitChangeEntry {
  return {
    path: normalizeGitChangePath(entry?.path),
    originalPath: null,
    additions: typeof entry?.added === "number" ? entry.added : 0,
    deletions: typeof entry?.removed === "number" ? entry.removed : 0,
    status: normalizeGitChangeStatus(entry?.status),
  }
}

export function adaptSdkGitStatusEntries(
  entries: SdkGitFileStatus[] | null | undefined,
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
      adaptedByPath.set(adapted.path, {
        ...adapted,
        originalPath: detail?.originalPath ? normalizeGitChangePath(detail.originalPath) : adapted.originalPath ?? null,
        stagedStatus: detail?.stagedStatus ?? null,
        unstagedStatus: detail?.unstagedStatus ?? null,
        stagedAdditions: detail?.stagedAdditions ?? 0,
      stagedDeletions: detail?.stagedDeletions ?? 0,
      unstagedAdditions: detail?.unstagedAdditions ?? 0,
      unstagedDeletions: detail?.unstagedDeletions ?? 0,
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
    })
  }

  return Array.from(adaptedByPath.values()).filter((entry) => entry.path.length > 0)
}

function buildGitChangeListItemId(section: GitChangeSection, path: string): string {
  return `${section}:${path}`
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
        entry,
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
        entry,
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
        entry,
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
