import type { OpenCodeClient, ShellInfo } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { z } from "zod"
import type { ServiceConnection } from "../workspaces/opencode-service"

// The pinned client predates experimental.job.list. Read only its shell identity
// projection, through the same authenticated, generation-fenced transport.
const jobsSchema = z.object({ data: z.array(z.object({ kind: z.literal("shell"), shellID: z.string() })) })
const MAX_JOB_BYTES = 4 * 1024 * 1024

export async function backgroundShellIds(connection: ServiceConnection, signal: AbortSignal): Promise<Set<string>> {
  const url = new URL("/api/experimental/job", connection.endpoint.url)
  url.searchParams.set("kind", "shell")
  url.searchParams.set("status", "running")
  const response = await connection.fetch(url, { headers: Service.headers(connection.endpoint), signal, redirect: "error" })
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new Error("OpenCode background job inventory is unavailable")
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_JOB_BYTES) throw new Error("OpenCode background job inventory exceeds its read budget")
      chunks.push(value)
    }
    connection.assertCurrent()
    const jobs = jobsSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")))
    return new Set(jobs.data.map(job => job.shellID))
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
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
