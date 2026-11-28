import type { PendingDirectoryErrorReason, WorkspacePendingRequestsResponse } from "../../../server/src/api-types"
import { HttpResponseError } from "../lib/retryable-file-search"

/** Why one directory's questions/permissions could not be recovered. */
export type PendingDirectoryIssue =
  | PendingDirectoryErrorReason
  | "timeout" // the snapshot request exceeded its deadline
  | "unavailable" // the server could not answer for it
  | "excluded" // required (active session or known request), yet reported as outside history

export type PendingRecoveryCause =
  | { kind: "directories"; directories: ReadonlyArray<{ directory: string; issue: PendingDirectoryIssue; detail?: string }> }
  | { kind: "unsupported" } // the bundled OpenCode plugin cannot list pending requests
  | { kind: "unstable" } // newer changes kept superseding recovery
  | { kind: "hydration"; detail: string } // the workspace did not finish loading
  | { kind: "request"; detail: string }

type SupportedSnapshot = Extract<WorkspacePendingRequestsResponse, { supported: true }>
type SnapshotDirectory = SupportedSnapshot["directories"][number]
export type RecoveryDirectory = Exclude<SnapshotDirectory, { status: "error" }> | {
  directory: string; status: "error"; reason?: PendingDirectoryIssue; detail?: string
  locations?: Extract<SnapshotDirectory, { status: "ok" }>["locations"]
}
/** The server snapshot, with client-side issues attached to the directories it could not cover. */
export type RecoverySnapshot = { supported: false } | { supported: true; directories: RecoveryDirectory[] }

const SERVER_REASONS = new Set<string>(["not-owned", "deleting", "missing", "unverified", "changed"])

/** The per-directory statuses a refused (403) snapshot request still reports, if any. */
export function refusedDirectories(error: unknown): RecoveryDirectory[] | undefined {
  if (!(error instanceof HttpResponseError) || error.status !== 403) return undefined
  const directories = (error.body as { directories?: unknown } | undefined)?.directories
  if (!Array.isArray(directories)) return undefined
  return directories.flatMap((entry): RecoveryDirectory[] => {
    if (typeof entry?.directory !== "string") return []
    if (entry.status === "excluded") return [{ directory: entry.directory, status: "excluded" }]
    if (entry.status !== "error") return []
    const reason = SERVER_REASONS.has(entry.reason) ? entry.reason as PendingDirectoryErrorReason : undefined
    return [{ directory: entry.directory, status: "error", reason }]
  })
}

export class PendingRecoveryError extends Error {
  constructor(readonly recoveryCause: PendingRecoveryCause) {
    super("Pending request recovery is incomplete")
  }
}

function errorDetail(error: unknown): string {
  if (error instanceof HttpResponseError) return `HTTP ${error.status}`
  return error instanceof Error ? error.message : String(error)
}

/** Classifies a failed snapshot batch request for every directory it carried. */
export function batchIssue(error: unknown): { issue: PendingDirectoryIssue; detail?: string } {
  if (error instanceof HttpResponseError && error.status === 403) return { issue: "not-owned" }
  if (error instanceof HttpResponseError && error.code === "timeout") return { issue: "timeout" }
  if (error instanceof DOMException && error.name === "AbortError") return { issue: "timeout" }
  return { issue: "unavailable", detail: errorDetail(error) }
}

export function recoveryCauseOf(error: unknown): PendingRecoveryCause {
  return error instanceof PendingRecoveryError ? error.recoveryCause : { kind: "request", detail: errorDetail(error) }
}

/** Initial loading failures keep a recovery cause when recovery itself is what failed. */
export function hydrationCause(error: unknown): PendingRecoveryCause {
  return error instanceof PendingRecoveryError ? error.recoveryCause : { kind: "hydration", detail: errorDetail(error) }
}

/** One error naming every failed directory; any other failure keeps its own meaning. */
export function combinePendingFailures(failures: readonly unknown[]): unknown {
  const directories = failures.flatMap((failure) => failure instanceof PendingRecoveryError
    && failure.recoveryCause.kind === "directories" ? failure.recoveryCause.directories : [])
  if (!directories.length || failures.some((failure) => !(failure instanceof PendingRecoveryError))) return failures[0]
  return new PendingRecoveryError({ kind: "directories", directories })
}
