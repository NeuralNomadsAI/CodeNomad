import assert from "node:assert/strict"
import test from "node:test"

import { validateMissionDelegationPolicy, validateMissionReportArtifact } from "./contracts"

test("accepts a green Pocock validation contract only when every check category is reported", () => {
  const artifact = {
    kind: "validation",
    checks: [
      { kind: "typecheck", command: "npm run typecheck", status: "passed", summary: "green" },
      { kind: "lint", command: "", status: "not-configured", summary: "no lint script" },
      { kind: "test", command: "npm test", status: "passed", summary: "42 passed" },
      { kind: "build", command: "npm run build", status: "passed", summary: "built" },
    ],
    focusedRegression: { command: "npm test -- cache", status: "passed", summary: "regression green" },
    verdict: "green",
  }
  assert.deepEqual(validateMissionReportArtifact({
    template: "pocock-fix-bug", role: "validator", outcome: "completed", artifact,
  }), artifact)

  assert.throws(() => validateMissionReportArtifact({
    template: "pocock-fix-bug",
    role: "validator",
    outcome: "completed",
    artifact: { ...artifact, checks: artifact.checks.filter((check) => check.kind !== "build") },
  }), /build must be reported/)
  assert.throws(() => validateMissionReportArtifact({
    template: "pocock-fix-bug",
    role: "validator",
    outcome: "completed",
    artifact: { ...artifact, checks: artifact.checks.map((check) => check.kind === "test" ? { ...check, status: "failed" } : check) },
  }), /failed check/)
})

test("keeps the two Pocock review axes structurally independent", () => {
  const standards = { kind: "review", axis: "standards", verdict: "pass", findings: [] }
  assert.deepEqual(validateMissionReportArtifact({
    template: "pocock-fix-bug", role: "review-standards", outcome: "completed", artifact: standards,
  }), standards)
  assert.throws(() => validateMissionReportArtifact({
    template: "pocock-fix-bug", role: "review-spec", outcome: "completed", artifact: standards,
  }), /axis/)
})

test("requires structured evidence only for completed Pocock roles", () => {
  assert.throws(() => validateMissionReportArtifact({
    template: "pocock-fix-bug", role: "diagnostician", outcome: "completed",
  }), /report contract failed/)
  assert.equal(validateMissionReportArtifact({
    template: "pocock-fix-bug", role: "diagnostician", outcome: "blocked",
  }), undefined)
  assert.equal(validateMissionReportArtifact({
    template: "custom", role: "specialist", outcome: "completed",
  }), undefined)
})

test("fences fresh Pocock reviewers and implementer-session resolution without fixed task keys", () => {
  const actors = [{
    sessionId: "ses_fix",
    kind: "specialist" as const,
    managed: true,
    title: "Implementer",
    roles: ["implementer"],
    location: { directory: "/repo" },
    joinedAt: 1,
  }]
  assert.doesNotThrow(() => validateMissionDelegationPolicy({
    template: "pocock-fix-bug", role: "resolver", targetSessionID: "ses_fix", actors,
    tasks: [{ role: "review-standards", status: "completed" }, { role: "review-spec", status: "completed" }],
  }))
  assert.throws(() => validateMissionDelegationPolicy({
    template: "pocock-fix-bug", role: "resolver", actors,
    tasks: [{ role: "review-standards", status: "completed" }, { role: "review-spec", status: "completed" }],
  }), /reuse the implementer/)
  assert.throws(() => validateMissionDelegationPolicy({
    template: "pocock-fix-bug", role: "review-spec", targetSessionID: "ses_fix", actors, tasks: [],
  }), /fresh root session/)
  assert.throws(() => validateMissionDelegationPolicy({
    template: "wayfinder", role: "implementer", actors, tasks: [],
  }), /not a wayfinder/)
})
