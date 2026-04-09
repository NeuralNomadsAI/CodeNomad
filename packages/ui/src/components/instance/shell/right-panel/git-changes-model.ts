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

export function buildGitChangeListItems(entries: GitChangeEntry[] | null | undefined): GitChangeListItem[] {
  if (!Array.isArray(entries)) return []

  const items: GitChangeListItem[] = []
  for (const entry of entries) {
    if (entry.stagedStatus) {
      items.push({
        id: buildGitChangeListItemId("staged", entry.path),
        path: entry.path,
        section: "staged",
        status: entry.stagedStatus,
        additions: entry.stagedAdditions ?? 0,
        deletions: entry.stagedDeletions ?? 0,
        entry,
      })
    }
    if (entry.unstagedStatus) {
      items.push({
        id: buildGitChangeListItemId("unstaged", entry.path),
        path: entry.path,
        section: "unstaged",
        status: entry.unstagedStatus,
        additions: entry.unstagedAdditions ?? entry.additions,
        deletions: entry.unstagedDeletions ?? entry.deletions,
        entry,
      })
    }
    if (!entry.stagedStatus && !entry.unstagedStatus) {
      items.push({
        id: buildGitChangeListItemId("unstaged", entry.path),
        path: entry.path,
        section: "unstaged",
        status: entry.status,
        additions: entry.additions,
        deletions: entry.deletions,
        entry,
      })
    }
  }

  return items.sort((a, b) => {
    if (a.section !== b.section) return a.section.localeCompare(b.section)
    return a.path.localeCompare(b.path)
  })
}
