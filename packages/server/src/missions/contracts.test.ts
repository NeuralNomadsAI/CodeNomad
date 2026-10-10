import assert from "node:assert/strict"
import test from "node:test"

import { resolveDebuggingImplementerSessionID, validateMissionCompletionPolicy, validateMissionDelegationPolicy, validateMissionReportArtifact, validateNativeDecisionArtifact } from "./contracts"
import type { MissionJsonValue, MissionTask } from "./model"

test("accepts a green Debugging validation contract only when every check category is reported", () => {
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
    template: "debug", role: "validator", outcome: "completed", artifact,
  }), artifact)

  assert.throws(() => validateMissionReportArtifact({
    template: "debug",
    role: "validator",
    outcome: "completed",
    artifact: { ...artifact, checks: artifact.checks.filter((check) => check.kind !== "build") },
  }), /build must be reported/)
  assert.throws(() => validateMissionReportArtifact({
    template: "debug",
    role: "validator",
    outcome: "completed",
    artifact: { ...artifact, checks: artifact.checks.map((check) => check.kind === "test" ? { ...check, status: "failed" } : check) },
  }), /failed check/)
})

test("keeps the two Debugging review axes structurally independent", () => {
  const standards = { kind: "review", axis: "standards", verdict: "pass", findings: [] }
  assert.deepEqual(validateMissionReportArtifact({
    template: "debug", role: "review-standards", outcome: "completed", artifact: standards,
  }), standards)
  assert.throws(() => validateMissionReportArtifact({
    template: "debug", role: "review-spec", outcome: "completed", artifact: standards,
  }), /axis/)
})

test("requires structured evidence only for completed Debugging roles", () => {
  assert.throws(() => validateMissionReportArtifact({
    template: "debug", role: "diagnostician", outcome: "completed",
  }), /report contract failed/)
  assert.equal(validateMissionReportArtifact({
    template: "debug", role: "diagnostician", outcome: "blocked",
  }), undefined)
  assert.equal(validateMissionReportArtifact({
    template: "custom", role: "specialist", outcome: "completed",
  }), undefined)
})

test("fences fresh Debugging reviewers and implementer-session resolution without fixed task keys", () => {
  const tasks = [
    { key: "fix", role: "implementer", status: "completed" as const, blockedBy: [], actorSessionId: "ses_fix" },
    { key: "standards", role: "review-standards", status: "completed" as const, blockedBy: ["fix"] },
    { key: "spec", role: "review-spec", status: "completed" as const, blockedBy: ["fix"] },
  ]
  assert.doesNotThrow(() => validateMissionDelegationPolicy({
    template: "debug", role: "resolver", targetSessionID: "ses_fix", blockedBy: ["standards", "spec"], tasks,
  }))
  assert.throws(() => validateMissionDelegationPolicy({
    template: "debug", role: "resolver", blockedBy: ["standards", "spec"], tasks,
  }), /reuse the live implementer/)
  assert.throws(() => validateMissionDelegationPolicy({
    template: "debug", role: "review-spec", targetSessionID: "ses_fix", tasks: [],
  }), /fresh root session/)
  assert.throws(() => validateMissionDelegationPolicy({
    template: "wayfinder", role: "implementer", tasks: [],
  }), /not a wayfinder/)
})

test("selects the implementer connected to Debugging review dependencies and rejects ambiguous lineage", () => {
  const tasks = [
    { key: "old-fix", role: "implementer", status: "withdrawn" as const, blockedBy: [], actorSessionId: "ses_old", replacedByTaskKey: "new-fix" },
    { key: "new-fix", role: "implementer", status: "completed" as const, blockedBy: [], actorSessionId: "ses_new" },
    { key: "other-fix", role: "implementer", status: "completed" as const, blockedBy: [], actorSessionId: "ses_other" },
    { key: "standards", role: "review-standards", status: "completed" as const, blockedBy: ["old-fix"] },
    { key: "spec", role: "review-spec", status: "completed" as const, blockedBy: ["new-fix"] },
  ]
  assert.doesNotThrow(() => validateMissionDelegationPolicy({
    template: "debug", role: "resolver", targetSessionID: "ses_new", blockedBy: ["standards", "spec"], tasks,
  }))
  assert.throws(() => validateMissionDelegationPolicy({
    template: "debug", role: "resolver", targetSessionID: "ses_other", blockedBy: ["standards", "spec"],
    tasks: tasks.map(task => task.key === "old-fix"
      ? { key: task.key, role: task.role, status: "completed" as const, blockedBy: [], actorSessionId: task.actorSessionId }
      : task),
  }), /unambiguous/)
})

test("resolves a Debugging chain with multiple implementer tasks to their one shared actor", () => {
  const tasks = [
    { key: "diagnose", role: "diagnostician", status: "completed" as const, blockedBy: [] },
    { key: "fix-part-one", role: "implementer", status: "completed" as const, blockedBy: ["diagnose"], actorSessionId: "ses_implementer" },
    { key: "fix-part-two", role: "implementer", status: "completed" as const, blockedBy: ["fix-part-one"], actorSessionId: "ses_implementer" },
    { key: "standards", role: "review-standards", status: "completed" as const, blockedBy: ["fix-part-two"] },
    { key: "spec", role: "review-spec", status: "completed" as const, blockedBy: ["fix-part-two"] },
  ]
  assert.equal(resolveDebuggingImplementerSessionID(tasks, ["standards", "spec"]), "ses_implementer")
  assert.doesNotThrow(() => validateMissionDelegationPolicy({
    template: "debug", role: "resolver", targetSessionID: "ses_implementer",
    blockedBy: ["standards", "spec"], tasks,
  }))

  const ambiguous = [...tasks,
    { key: "other-fix", role: "implementer", status: "completed" as const, blockedBy: ["diagnose"], actorSessionId: "ses_other" },
  ].map(task => task.key === "spec" ? { ...task, blockedBy: ["fix-part-two", "other-fix"] } : task)
  assert.equal(resolveDebuggingImplementerSessionID(ambiguous, ["standards", "spec"]), undefined)
})

const native = { kind: "native", parentTaskKey: null } as const

test("native declarations validate topology without admitting incomplete prerequisite work", () => {
  const tasks = [
    { key: "diagnose", role: "diagnostician", status: "ready" as const, blockedBy: [] },
    { key: "fix", role: "implementer", status: "blocked" as const, blockedBy: ["diagnose"] },
    { key: "standards", role: "review-standards", status: "blocked" as const, blockedBy: ["fix"] },
    { key: "spec", role: "review-spec", status: "blocked" as const, blockedBy: ["fix"] },
  ]
  const input = { template: "debug" as const, role: "resolver", blockedBy: ["standards", "spec"],
    executionMode: { ...native, reuseFromTaskKey: "fix" }, tasks }
  assert.doesNotThrow(() => validateMissionDelegationPolicy({ ...input, phase: "declaration" }))
  assert.throws(() => validateMissionDelegationPolicy(input), /exact completed implementer/)
  assert.doesNotThrow(() => validateMissionDelegationPolicy({
    template: "debug", role: "implementer", blockedBy: ["diagnose"], tasks, phase: "declaration",
  }))
  assert.throws(() => validateMissionDelegationPolicy({ ...input, blockedBy: ["missing"], phase: "declaration" }), /existing task/)
  assert.throws(() => validateMissionDelegationPolicy({ ...input, blockedBy: [], phase: "declaration" }), /dependency-connected/)
  assert.throws(() => validateMissionDelegationPolicy({ ...input, role: "unknown", phase: "declaration" }), /not a debug/)
  assert.throws(() => validateMissionDelegationPolicy({ ...input, executionMode: { ...native, parentTaskKey: "missing" }, phase: "declaration" }), /parent/)
  assert.doesNotThrow(() => validateMissionDelegationPolicy({ ...input, role: "review-spec", blockedBy: ["fix"], executionMode: native, phase: "declaration" }))
  assert.throws(() => validateMissionDelegationPolicy({ ...input, role: "review-spec", blockedBy: ["fix"], executionMode: native }), /dependency-connected implementer/)
})

test("native fresh reviewers and validators reject explicit reuse without requiring root shape", () => {
  const tasks = nativeDebuggingChain()
  for (const role of ["review-standards", "review-spec", "validator"]) {
    const blockedBy = role === "validator" ? ["resolve"] : ["fix"]
    const input = { template: "debug" as const, role, blockedBy, tasks, executionMode: native }
    assert.doesNotThrow(() => validateMissionDelegationPolicy(input))
    assert.throws(() => validateMissionDelegationPolicy({ ...input, targetSessionID: "ses_child" }), /fresh distinct/)
    assert.throws(() => validateMissionDelegationPolicy({ ...input, executionMode: { ...native, reuseFromTaskKey: "fix" } }), /fresh distinct/)
  }
})

test("native resolver names one exact reported implementer and never uses legacy unrelated fallback", () => {
  const tasks = nativeDebuggingChain()
  const mode = { ...native, reuseFromTaskKey: "fix" }
  assert.equal(resolveDebuggingImplementerSessionID(tasks, ["standards", "spec"], mode), "ses_fix")
  assert.doesNotThrow(() => validateMissionDelegationPolicy({ template: "debug", role: "resolver",
    tasks, blockedBy: ["standards", "spec"], executionMode: mode, targetSessionID: "ses_fix" }))
  assert.equal(resolveDebuggingImplementerSessionID(tasks, [], mode), undefined)
  assert.equal(resolveDebuggingImplementerSessionID(tasks, []), "ses_fix", "legacy sole-actor fallback is preserved")
  assert.equal(resolveDebuggingImplementerSessionID(tasks, ["standards", "spec"], native), undefined)
  assert.equal(resolveDebuggingImplementerSessionID(tasks.map(task => task.key === "fix" ? { ...task, report: undefined } : task), ["standards", "spec"], mode), undefined)
  assert.equal(resolveDebuggingImplementerSessionID(tasks.map(task => task.key === "fix"
    ? { ...task, report: { ...task.report!, sessionId: "ses_other" } } : task), ["standards", "spec"], mode), undefined)
  assert.equal(resolveDebuggingImplementerSessionID(tasks.map(task => task.key === "fix"
    ? { ...task, replacedByTaskKey: "new-fix" } : task), ["standards", "spec"], mode), undefined)
  // No idle/ended claims are accepted here: binding and exact current execution observations are authority-owned.
})

test("green native Debugging completion requires applicable evidence for the latest live fix", () => {
  const tasks = nativeDebuggingChain()
  const policy = (tasks: MissionTask[]) => validateMissionCompletionPolicy({ template: "debug", outcome: "completed", tasks })
  assert.doesNotThrow(() => policy(tasks))
  const laterFix = { ...tasks[1]!, id: "new-fix", key: "new-fix", createdAt: 20,
    report: { ...tasks[1]!.report!, taskKey: "new-fix" } }
  assert.throws(() => policy([...tasks, laterFix]), /dependency-connected/)
  const sameTimeDependentFix = { ...laterFix, createdAt: tasks[1]!.createdAt, blockedBy: ["fix"] }
  assert.throws(() => policy([...tasks, sameTimeDependentFix]), /dependency-connected/, "same-revision dependency tips supersede old reviews")
  const sameTimeUnrelatedFix = { ...laterFix, createdAt: tasks[1]!.createdAt }
  assert.throws(() => policy([...tasks, sameTimeUnrelatedFix]), /latest live implementation/, "ambiguous latest implementations fail closed")
  assert.throws(() => policy(tasks.map(task => task.role === "review-spec"
    ? { ...task, blockedBy: [] } : task)), /dependency-connected/)
  assert.throws(() => policy(tasks.map(task => task.role === "validator"
    ? { ...task, report: undefined } : task)), /exact completed validator report/)
  assert.throws(() => policy(tasks.map(task => task.role === "review-spec"
    ? { ...task, report: { ...task.report!, artifact: { kind: "review", axis: "standards", verdict: "pass", findings: [] } } } : task)), /axis/)
  assert.doesNotThrow(() => validateMissionCompletionPolicy({ template: "debug", outcome: "completed",
    tasks: tasks.map(({ role, status }) => ({ role, status })) }), "historical role-only proof gate remains valid")
})

function nativeDebuggingChain(): MissionTask[] {
  const artifacts: Record<string, MissionJsonValue> = {
    diagnostician: { kind: "diagnosis", feedbackLoop: { command: "test", redOutput: "red" }, minimizedRepro: "repro",
      confirmedHypothesis: "cause", evidence: "observed", rejectedHypotheses: [] },
    implementer: { kind: "fix", changedFiles: ["fix.ts"], regressionTest: { seam: "present", path: "fix.test.ts", command: "test",
      redObserved: true, greenObserved: true }, originalLoopGreen: true, debugInstrumentationRemoved: true, prevention: "test" },
    "review-standards": { kind: "review", axis: "standards", verdict: "pass", findings: [] },
    "review-spec": { kind: "review", axis: "spec", verdict: "pass", findings: [] },
    resolver: { kind: "resolution", addressed: [], deferred: [], focusedChecks: [{ command: "test", passed: true }] },
    validator: { kind: "validation", checks: ["typecheck", "lint", "test", "build"].map(kind =>
      ({ kind, command: kind, status: "passed", summary: "green" })), focusedRegression: { command: "test", status: "passed", summary: "green" }, verdict: "green" },
  }
  return [
    { key: "diagnose", role: "diagnostician", blockedBy: [] },
    { key: "fix", role: "implementer", blockedBy: ["diagnose"] },
    { key: "standards", role: "review-standards", blockedBy: ["fix"] },
    { key: "spec", role: "review-spec", blockedBy: ["fix"] },
    { key: "resolve", role: "resolver", blockedBy: ["standards", "spec"] },
    { key: "validate", role: "validator", blockedBy: ["resolve"] },
  ].map((task, index) => ({ ...task, id: task.key, title: task.key, brief: task.key, status: "completed", executionMode: native,
    actorSessionId: `ses_${task.key}`, createdAt: index, updatedAt: index, outstandingExecution: false, contractGeneration: 1,
    report: { id: `report_${task.key}`, taskKey: task.key, sessionId: `ses_${task.key}`, outcome: "completed",
      summary: "completed", evidence: ["observed"], next: [], createdAt: index, artifact: artifacts[task.role] },
  }))
}

const decisionBinding = { contract: { missionID: "mission_test", taskKey: "decision", generation: 2 },
  call: { generation: 2, parentSessionID: "ses_parent", parentMessageID: "msg_parent", toolCallID: "call_parent" }, sessionID: "ses_child" }
const decisionArtifact = () => ({ kind: "decision", question: "Choose?", answer: "Module", provenance: {
  kind: "native-form-answer", contract: { ...decisionBinding.contract }, nativeCall: { ...decisionBinding.call },
  sessionID: "ses_child", formID: "form_actual", messageID: "msg_question", toolCallID: "call_question", fieldKey: "q0" } })

test("native Wayfinder decision syntax binds exact contract, generation, invocation and Form identifiers", () => {
  const artifact = decisionArtifact()
  assert.equal(validateNativeDecisionArtifact({ ...decisionBinding, artifact }).formID, "form_actual")
  assert.equal(validateMissionReportArtifact({ template: "wayfinder", role: "decision", outcome: "completed",
    nativeDecision: decisionBinding, artifact }), artifact)
  for (const property of ["formID", "messageID", "toolCallID"] as const) {
    const invalid = decisionArtifact(); invalid.provenance[property] = ""
    assert.throws(() => validateNativeDecisionArtifact({ ...decisionBinding, artifact: invalid }))
  }
  assert.throws(() => validateNativeDecisionArtifact({ ...decisionBinding, contract: { ...decisionBinding.contract, generation: 3 }, artifact }), /current task/)
  assert.throws(() => validateNativeDecisionArtifact({ ...decisionBinding, contract: { ...decisionBinding.contract, taskKey: "another" }, artifact }), /current task/)
  assert.throws(() => validateNativeDecisionArtifact({ ...decisionBinding, call: { ...decisionBinding.call, toolCallID: "call_other" }, artifact }), /current task/)
  assert.throws(() => validateNativeDecisionArtifact({ ...decisionBinding, sessionID: "ses_other", artifact }), /current task/)
})

test("native decisions reject fake humanAnswer and never upgrade historical independent reports", () => {
  assert.throws(() => validateMissionReportArtifact({ template: "wayfinder", role: "decision", outcome: "completed",
    nativeDecision: decisionBinding, artifact: { kind: "decision", humanAnswer: true, answer: "Module" } }))
  const fake = { ...decisionArtifact(), humanAnswer: true }
  assert.throws(() => validateNativeDecisionArtifact({ ...decisionBinding, artifact: fake }))
  const malformed = decisionArtifact(); Object.assign(malformed.provenance, { humanAnswer: true })
  assert.throws(() => validateNativeDecisionArtifact({ ...decisionBinding, artifact: malformed }))
  const historical = { kind: "decision", question: "Choose?", humanAnswer: true }
  assert.equal(validateMissionReportArtifact({ template: "wayfinder", role: "decision", outcome: "completed", artifact: historical }), historical)
  assert.equal(validateMissionReportArtifact({ template: "wayfinder", role: "decision", outcome: "blocked",
    nativeDecision: decisionBinding, artifact: historical }), historical)
})
