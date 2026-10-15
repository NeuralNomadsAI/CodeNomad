import assert from "node:assert/strict"
import { test } from "node:test"
import { HttpResponseError } from "../lib/retryable-file-search"
import {
  batchIssue, combinePendingFailures, describePendingRecovery, PendingRecoveryError, recoveryCauseOf, refusedDirectories,
} from "./pending-recovery-cause"

// Echoes each key with its parameters so assertions show exactly what the user would read.
const t = (key: string, params: Record<string, string | number> = {}) =>
  `${key}(${Object.entries(params).map(([name, value]) => `${name}=${value}`).join(";")})`
const none = () => []

test("folders are grouped by cause, named by basename and capped with a remainder", () => {
  const { title, message } = describePendingRecovery({ kind: "directories", directories: [
    { directory: "D:\\CodeNomad\\.codenomad\\worktrees\\prompt-replay-yield", issue: "not-owned" },
    ...["a", "b", "c", "d"].map((name) => ({ directory: `/repo/${name}/`, issue: "missing" as const })),
  ] }, "CodeNomad", (directories) => directories.length === 5 ? ["ISSUES Codenomad"] : [], t)
  assert.equal(title, "interruption.recoveryIncomplete.title(workspace=CodeNomad)")
  assert.equal(message, [
    "interruption.recoveryIssue.notOwned(directories=prompt-replay-yield;detail=)",
    "interruption.recoveryIssue.missing(directories=a, b, c (+1);detail=)",
    "interruption.recoverySessions(sessions=ISSUES Codenomad)",
  ].join(" "))
})

test("an unanswered folder shows the server detail only when there is one", () => {
  const describe = (detail?: string) => describePendingRecovery({ kind: "directories", directories: [
    { directory: "/repo", issue: "unavailable", detail },
  ] }, "repo", none, t).message
  assert.equal(describe(), "interruption.recoveryIssue.unavailable(directories=repo;detail=)")
  assert.equal(describe("HTTP 503"), "interruption.recoveryIssue.unavailableDetail(directories=repo;detail=HTTP 503)")
})

test("non-folder causes keep their own message and detail", () => {
  for (const [cause, expected] of [
    [{ kind: "unsupported" }, "interruption.recoveryCause.unsupported(detail=)"],
    [{ kind: "unstable" }, "interruption.recoveryCause.unstable(detail=)"],
    [{ kind: "hydration", detail: "worktrees" }, "interruption.recoveryCause.hydration(detail=worktrees)"],
  ] as const) assert.equal(describePendingRecovery(cause, "repo", none, t).message, expected)
})

test("folders sharing a name keep their parent so each one stays visible", () => {
  const { message } = describePendingRecovery({ kind: "directories", directories: [
    { directory: "/repo/.codenomad/worktrees/app", issue: "missing" },
    { directory: "/other/app", issue: "missing" },
    { directory: "/repo/.codenomad/worktrees/app", issue: "missing" },
  ] }, "repo", none, t)
  assert.equal(message, "interruption.recoveryIssue.missing(directories=worktrees/app, other/app;detail=)")
})

test("a refused batch keeps each folder's reported status and reason", () => {
  const refused = new HttpResponseError("Directory does not belong to workspace", 403, null, undefined, { directories: [
    { directory: "/gone", status: "error", reason: "missing" },
    { directory: "/history", status: "excluded" },
    { directory: "/odd", status: "error", reason: "made-up" },
    { directory: 42, status: "error" },
  ] })
  assert.deepEqual(refusedDirectories(refused), [
    { directory: "/gone", status: "error", reason: "missing" },
    { directory: "/history", status: "excluded" },
    { directory: "/odd", status: "error", reason: undefined },
  ])
  assert.equal(refusedDirectories(new HttpResponseError("Directory does not belong to workspace", 403, null)), undefined, "an older server's bare refusal")
  assert.equal(refusedDirectories(new HttpResponseError("Unavailable", 503, null, undefined, { directories: [] })), undefined)
})

test("request failures map to the folder issue the user can act on", () => {
  assert.deepEqual(batchIssue(new HttpResponseError("Directory does not belong to workspace", 403, null)), { issue: "not-owned" })
  assert.deepEqual(batchIssue(new HttpResponseError("Pending requests unavailable", 503, "30")), { issue: "unavailable", detail: "HTTP 503" })
  assert.deepEqual(batchIssue(new HttpResponseError("Pending requests unavailable", 503, null, "timeout")), { issue: "timeout" })
  assert.deepEqual(batchIssue(new HttpResponseError("Pending discovery deferred", 503, "30", "deferred")), { issue: "deferred" })
  assert.deepEqual(batchIssue(new DOMException("aborted", "AbortError")), { issue: "timeout" })
  assert.deepEqual(recoveryCauseOf(new Error("socket hang up")), { kind: "request", detail: "socket hang up" })
})

test("failed folders combine into one cause; any other failure keeps its meaning", () => {
  const folder = (directory: string) => new PendingRecoveryError({ kind: "directories", directories: [{ directory, issue: "changed" }] })
  assert.deepEqual(recoveryCauseOf(combinePendingFailures([folder("/a"), folder("/b")])), { kind: "directories", directories: [
    { directory: "/a", issue: "changed" }, { directory: "/b", issue: "changed" },
  ] })
  // Mixed failures keep the previous behaviour: the first one is rethrown unchanged.
  const deferred = new Error("deferred"), first = folder("/a")
  assert.equal(combinePendingFailures([deferred, folder("/a")]), deferred)
  assert.equal(combinePendingFailures([first, deferred]), first)
})
