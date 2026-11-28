import assert from "node:assert/strict"
import { test } from "node:test"
import { HttpResponseError } from "../lib/retryable-file-search"
import {
  batchIssue, combinePendingFailures, hydrationCause, PendingRecoveryError, recoveryCauseOf, refusedDirectories,
} from "./pending-recovery-cause"

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
  assert.deepEqual(batchIssue(new DOMException("aborted", "AbortError")), { issue: "timeout" })
  assert.deepEqual(recoveryCauseOf(new Error("socket hang up")), { kind: "request", detail: "socket hang up" })
})

test("an initial load that failed in recovery keeps the recovery cause", () => {
  const recovery = new PendingRecoveryError({ kind: "directories", directories: [{ directory: "/repo", issue: "missing" }] })
  assert.deepEqual(hydrationCause(recovery), recovery.recoveryCause)
  assert.deepEqual(hydrationCause(new Error("Worktree metadata unavailable")), { kind: "hydration", detail: "Worktree metadata unavailable" })
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
