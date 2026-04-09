import type { File as SdkGitFileStatus } from "@opencode-ai/sdk/v2/client"
import type { WorktreeGitStatusEntry } from "../../../../../../server/src/api-types"

import type { GitChangeEntry, GitChangeStatus } from "./types"

export function normalizeGitChangeStatus(status: unknown): GitChangeStatus {
  return typeof status === "string" && status.trim().length > 0 ? status : "modified"
}

export function adaptSdkGitStatusEntry(entry: SdkGitFileStatus): GitChangeEntry {
  return {
    path: typeof entry?.path === "string" ? entry.path : "",
    additions: typeof entry?.added === "number" ? entry.added : 0,
    deletions: typeof entry?.removed === "number" ? entry.removed : 0,
    status: normalizeGitChangeStatus(entry?.status),
  }
}

export function adaptSdkGitStatusEntries(
  entries: SdkGitFileStatus[] | null | undefined,
  details?: WorktreeGitStatusEntry[] | null,
): GitChangeEntry[] {
  if (!Array.isArray(entries)) return []
  const detailsByPath = new Map((details ?? []).map((entry) => [entry.path, entry]))
  return entries
    .map((entry) => {
      const adapted = adaptSdkGitStatusEntry(entry)
      const detail = detailsByPath.get(adapted.path)
      return detail
        ? {
            ...adapted,
            stagedStatus: detail.stagedStatus,
            unstagedStatus: detail.unstagedStatus,
          }
        : adapted
    })
    .filter((entry) => entry.path.length > 0)
}
