import type { OpenCodeClient, ShellInfo } from "@opencode/client"
import type { ServiceConnection } from "../workspaces/opencode-service"

export async function backgroundShellIds(connection: ServiceConnection, signal: AbortSignal): Promise<Set<string>> {
  const jobs = await connection.client.experimental.job.list({ kind: "shell", status: "running" }, { signal })
  connection.assertCurrent()
  if (!Array.isArray(jobs)) throw new Error("OpenCode background job inventory is unavailable")
  const ids = new Set<string>()
  for (const job of jobs) {
    if (job.kind === "shell" && typeof job.shellID === "string") ids.add(job.shellID)
  }
  return ids
}

/** A tool's cwd can be outside its session's project (a build in a temp dir).
 * Session ownership is authoritative for those shells; direct API shells use cwd. */
export async function ownedShellDirectory(shell: ShellInfo, client: OpenCodeClient,
  ownsDirectory: (directory: string) => Promise<boolean>, signal: AbortSignal): Promise<string | undefined> {
  const sessionID = shell.metadata.sessionID
  const directory = typeof sessionID === "string"
    ? (await client.session.get({ sessionID }, { signal })).location.directory : shell.cwd
  return await ownsDirectory(directory) ? directory : undefined
}
