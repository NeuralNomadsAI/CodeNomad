import type { ShellInfo } from "@opencode/client"

/** A location-scoped running Shell without a usable native session correlation
 * cannot prove either family ownership or unrelatedness. Only reads use this
 * classification; it never authorizes a send or changes native state. */
export function runningMissionShellRelation(shell: ShellInfo, family: ReadonlySet<string>): "related" | "unrelated" | "unknown" {
  if (shell.status !== "running") return "unrelated"
  const sessionID = shell.metadata?.sessionID
  if (typeof sessionID !== "string" || !sessionID.trim()) return "unknown"
  return family.has(sessionID) ? "related" : "unrelated"
}
