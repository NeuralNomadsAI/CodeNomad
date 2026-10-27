import type { WorkspaceManager } from "../../workspaces/manager"
import type { OpenCodeClient } from "@opencode/client"
import { readLocationRef } from "../../opencode/compatibility/location"

const normalized = (directory: string) => (/^[A-Za-z]:[\\/]|^\\\\/.test(directory) ? directory.replaceAll("\\", "/") : directory).replace(/\/$/, "")

export async function historyDirectories(manager: Pick<WorkspaceManager, "getWorktrees">, id: string, root: string) {
  return Array.from(new Set([root, ...(await manager.getWorktrees(id, "validated")).worktrees
    .map(worktree => worktree.serviceDirectory).filter((directory): directory is string => Boolean(directory))]))
    .sort().filter((directory, _index, all) => !all.some(other => other !== directory && normalized(directory).startsWith(`${normalized(other)}/`)))
}

/** Cache location ownership only for this response, including count-only owners. */
export async function ownedHistorySessions<T extends { sessionID: string; directory: string; workspaceID?: string }>(
  manager: Pick<WorkspaceManager, "ownsLocation">, id: string, client: OpenCodeClient, sessions: T[],
  sessionID?: string, current: () => void = () => {}, signal?: AbortSignal,
): Promise<T[]> {
  const ownership = new Map<string, boolean>(), owned: T[] = []
  for (const candidate of sessions) {
    if (sessionID && candidate.sessionID !== sessionID) throw new Error("Invalid history owner")
    const key = JSON.stringify([candidate.directory, candidate.workspaceID])
    if (!ownership.has(key)) ownership.set(key, await manager.ownsLocation(id, readLocationRef(candidate), client, signal))
    current()
    if (ownership.get(key)) owned.push(candidate)
  }
  return owned
}
