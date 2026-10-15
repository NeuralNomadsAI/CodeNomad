import type { PendingDirectoryErrorReason, WorkspacePendingRequestsResponse } from "../../../server/src/api-types"
import { getPathBasename } from "../lib/instance-label"
import { HttpResponseError } from "../lib/retryable-file-search"

/** Why one directory's questions/permissions could not be recovered. */
export type PendingDirectoryIssue =
  | PendingDirectoryErrorReason
  | "timeout" // the snapshot request exceeded its deadline
  | "deferred" // the server deferred discovery while a session compacts
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
  if (error instanceof HttpResponseError && error.code === "deferred") return { issue: "deferred" }
  if (error instanceof DOMException && error.name === "AbortError") return { issue: "timeout" }
  return { issue: "unavailable", detail: errorDetail(error) }
}

export function recoveryCauseOf(error: unknown): PendingRecoveryCause {
  return error instanceof PendingRecoveryError ? error.recoveryCause : { kind: "request", detail: errorDetail(error) }
}

export function hydrationCause(error: unknown): PendingRecoveryCause {
  return { kind: "hydration", detail: errorDetail(error) }
}

/** One error naming every failed directory; any other failure keeps its own meaning. */
export function combinePendingFailures(failures: readonly unknown[]): unknown {
  const directories = failures.flatMap((failure) => failure instanceof PendingRecoveryError
    && failure.recoveryCause.kind === "directories" ? failure.recoveryCause.directories : [])
  if (!directories.length || failures.some((failure) => !(failure instanceof PendingRecoveryError))) return failures[0]
  return new PendingRecoveryError({ kind: "directories", directories })
}

const ISSUE_KEYS: Record<PendingDirectoryIssue, string> = {
  "not-owned": "interruption.recoveryIssue.notOwned",
  deleting: "interruption.recoveryIssue.deleting",
  missing: "interruption.recoveryIssue.missing",
  unverified: "interruption.recoveryIssue.unverified",
  changed: "interruption.recoveryIssue.changed",
  timeout: "interruption.recoveryIssue.timeout",
  deferred: "interruption.recoveryIssue.deferred",
  unavailable: "interruption.recoveryIssue.unavailable",
  excluded: "interruption.recoveryIssue.excluded",
}

const MAX_LISTED = 3

/** Short folder names; folders sharing a name keep their parent to stay distinct. */
function folderNames(directories: readonly string[]): Map<string, string> {
  const unique = [...new Set(directories)]
  const counts = new Map<string, number>()
  for (const directory of unique) counts.set(getPathBasename(directory), (counts.get(getPathBasename(directory)) ?? 0) + 1)
  return new Map(unique.map((directory) => {
    const name = getPathBasename(directory)
    if (counts.get(name) === 1) return [directory, name]
    const parent = getPathBasename(directory.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]*$/, ""))
    return [directory, `${parent}/${name}`]
  }))
}

function list(values: readonly string[]): string {
  const unique = [...new Set(values)]
  return unique.length > MAX_LISTED ? `${unique.slice(0, MAX_LISTED).join(", ")} (+${unique.length - MAX_LISTED})` : unique.join(", ")
}

type Translate = (key: string, params?: Record<string, string | number>) => string

/** The warning's title (workspace) and message (cause, folders and affected sessions). */
export function describePendingRecovery(
  cause: PendingRecoveryCause,
  workspace: string,
  sessionTitlesIn: (directories: readonly string[]) => string[],
  t: Translate,
): { title: string; message: string } {
  const title = t("interruption.recoveryIncomplete.title", { workspace })
  if (cause.kind !== "directories") {
    const detail = "detail" in cause ? cause.detail : ""
    return { title, message: t(`interruption.recoveryCause.${cause.kind}`, { detail }) }
  }
  const names = folderNames(cause.directories.map(({ directory }) => directory))
  const byIssue = new Map<PendingDirectoryIssue, { directories: string[]; details: string[] }>()
  for (const { directory, issue, detail } of cause.directories) {
    const entry = byIssue.get(issue) ?? { directories: [], details: [] }
    entry.directories.push(directory)
    if (detail) entry.details.push(detail)
    byIssue.set(issue, entry)
  }
  const lines = [...byIssue].map(([issue, { directories, details }]) => t(issue === "unavailable" && details.length
    ? "interruption.recoveryIssue.unavailableDetail" : ISSUE_KEYS[issue], {
    directories: list(directories.map((directory) => names.get(directory)!)),
    detail: list(details),
  }))
  const titles = sessionTitlesIn(cause.directories.map(({ directory }) => directory))
  if (titles.length) lines.push(t("interruption.recoverySessions", { sessions: list(titles) }))
  return { title, message: lines.join(" ") }
}
