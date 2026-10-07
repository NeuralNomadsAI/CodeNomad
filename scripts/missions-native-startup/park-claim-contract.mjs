// Fixture enrollment only; neither a Mission authorization nor a persisted native Job.
import assert from "node:assert/strict"
import { appendFileSync } from "node:fs"
import path from "node:path"
import { exitHandleAcknowledged } from "./managed-exit-witness.mjs"
import { JOB_RPC } from "./job-contract.mjs"
export const PARK_RPC = { id: "missions.fixture-park-wait", methods: { inspect: JOB_RPC.methods.inspect }, events: {} }
export const currentGenerationExitProof = (proof, nonce, generation) => Number.isSafeInteger(generation) && generation > 0
  && proof?.admissionGeneration === generation && exitHandleAcknowledged(proof, nonce)
export const WATCH_MS = 120_000
export const parkWatch = (enrolled, nonce, directory, sessionID) => {
  assert.equal(enrolled.nonce, nonce)
  assert.equal(enrolled.directory, directory)
  assert.equal(enrolled.sessionID, sessionID)
  assert.equal(enrolled.permission.effect, "allow")
  const watch = enrolled.watch
  assert.equal(watch.pendingID, `finite_watch_${nonce.replaceAll("-", "")}`)
  assert.equal(watch.intent, "one finite authorized watch; park twice; no passage completion")
  assert.ok(Number.isSafeInteger(watch.createdAt) && Number.isSafeInteger(watch.deadlineAt))
  assert.equal(watch.deadlineAt - watch.createdAt, WATCH_MS)
  assert.ok(Date.now() >= watch.createdAt && Date.now() < watch.deadlineAt)
  return Object.freeze({ ...watch })
}
// Private diagnostics only: never serialize Cause/Context, Error properties, bodies or credentials.
export const captureFirstJobFailure = (diagnostic, errors, interrupted, write = appendFileSync) => {
  if (diagnostic.firstErrorCaptured) return
  diagnostic.firstErrorCaptured = true // A failed diagnostic write must not replace/retry the original error.
  try {
    const root = process.env.NATIVE_STARTUP_ROOT, file = process.env.NATIVE_STARTUP_MARKER
    const relative = path.relative(path.join(root, "markers"), file)
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative))
    const bounded = errors.slice(0, 2).map(error => {
      const missing = /Service not found: (@opencode\/(?:Job|example\/LocationServiceMap|Session|Location|LocationLifecycle|Permission|Agent))(?:\s|$)/.exec(error.message)
      const firstLine = String(error.message).split("\n", 1)[0]
      const message = missing ? `Service not found: ${missing[1]}`
        : ["Expected values to be strictly equal:", "No duplicate live job or hidden admission retry"].includes(firstLine)
          ? firstLine : "[redacted unclassified error message]"
      const stack = String(error.stack).split("\n").slice(1, 9).map(line => {
        const frame = /at ([A-Za-z0-9_.$<>]+) .*:(\d+):(\d+)\)?$/.exec(line)
        return frame ? `at ${frame[1]} (fixture:${frame[2]}:${frame[3]})` : "[redacted frame]"
      }).join("\n")
      return { name: ["Error", "AssertionError", "TypeError", "RangeError", "SyntaxError"].includes(error.name) ? error.name : "Error",
        message, stack, ...(error.code === "ERR_ASSERTION" ? { code: error.code } : {}) }
    })
    const line = JSON.stringify({ kind: "park-helper-first-cause", nonce: process.env.NATIVE_STARTUP_NONCE,
      pid: process.pid, at: Date.now(), facts: { stage: diagnostic.stage, chargedAttempts: 1,
        admissionACKObserved: diagnostic.admissionACKObserved, ...(typeof diagnostic.jobsStartInvoked === "boolean"
          ? { jobsStartInvoked: diagnostic.jobsStartInvoked } : {}), serviceHandleIDs: Object.fromEntries(
          ["jobs", "map", "sessions"].filter(key => Number.isSafeInteger(diagnostic.serviceHandleIDs?.[key]))
            .map(key => [key, diagnostic.serviceHandleIDs[key]])), interrupted, errors: bounded, replay: false } })
    assert.ok(line.length < 4096)
    write(file, line + "\n", { mode: 0o600 })
  } catch { /* Preserve the original Effect Cause and unknown admission, even if recording fails. */ }
}
// Hash-guarded build adapter of the existing adoption helper; no duplicated native adoption.
export const adaptJobHelper = input => {
  let source = input.replaceAll("\r\n", "\n")
  const replace = (from, to) => { assert.equal(source.split(from).length, 2, from); source = source.replace(from, to) }
  replace('import emit from "./emit.cjs"', 'import emit from "./emit.cjs"\nimport { parkWatch, captureFirstJobFailure } from "./park-claim-contract.mjs"')
  replace('workspaceID: current.location.workspaceID ?? null, jobID: id, phase: input.phase, enrollmentPermissionID: enrolled.permission.id',
    'workspaceID: current.location.workspaceID ?? null, jobID: id, phase: input.phase, enrollmentPermissionID: enrolled.permission.id, deadlineAt: parkWatch(enrolled, nonce, declared, input.sessionID).deadlineAt')
  replace('delayMs: input.phase === "due" ? 20_000 : 90_000', 'delayMs: Math.max(1, declared.deadlineAt - Date.now())')
  replace('function* () {\n    const jobs = yield* tags.jobs, map = yield* tags.map, sessions = yield* tags.sessions',
    'function* (diagnostic) {\n    if (diagnostic) diagnostic.stage = "service:Job"; const jobs = yield* tags.jobs;\n    if (diagnostic) { diagnostic.serviceHandleIDs = { jobs: objectID(jobs) }; diagnostic.stage = "service:LocationServiceMap" } const map = yield* tags.map;\n    if (diagnostic) { diagnostic.serviceHandleIDs.map = objectID(map); diagnostic.stage = "service:Session" } const sessions = yield* tags.sessions;\n    if (diagnostic) { diagnostic.serviceHandleIDs.sessions = objectID(sessions); diagnostic.stage = "service-shape-decode" }')
  replace('function* (input, sessions) {', 'function* (input, sessions, diagnostic) {\n    if (diagnostic) diagnostic.stage = "input-identity"')
  replace('const enrolled = yield* Effect.promise', 'if (diagnostic) diagnostic.stage = "enrollment-read";\n    const enrolled = yield* Effect.promise')
  replace('const current = yield* sessions.get(input.sessionID)', 'if (diagnostic) diagnostic.stage = "session-placement-read";\n    const current = yield* sessions.get(input.sessionID)')
  replace('assert.equal(current.location.directory, declared)', 'if (diagnostic) diagnostic.stage = "raw-session-directory-equality";\n    assert.equal(current.location.directory, declared)')
  replace('return Object.freeze({ nonce, sessionID: input.sessionID', 'if (diagnostic) diagnostic.stage = "fixture-watch-contract";\n    return Object.freeze({ nonce, sessionID: input.sessionID')
  replace('start: (input, call) => Effect.gen(function* () {', 'start: (input, call) => {\n      const diagnostic = { stage: "helper-entry", admissionACKObserved: false };\n      const observeCause = cause => Effect.sync(() => {\n        try { captureFirstJobFailure(diagnostic, Cause.prettyErrors(cause), Cause.hasInterruptsOnly(cause)) } catch {}\n      });\n      return Effect.gen(function* () {')
  replace('const { jobs, map, sessions } = yield* services()', 'const { jobs, map, sessions } = yield* services(diagnostic)')
  replace('const declared = yield* identityFor(input, sessions)', 'const declared = yield* identityFor(input, sessions, diagnostic)\n      diagnostic.stage = "origin-location-lifecycle-permission"')
  replace('const callerScopeID = objectID(yield* Effect.scope)', 'diagnostic.stage = "caller-scope-finalizer";\n      const callerScopeID = objectID(yield* Effect.scope)')
  replace('const allowed = yield* permissions.ask({ sessionID: declared.sessionID', 'diagnostic.stage = "native-permission";\n      const allowed = yield* permissions.ask({ sessionID: declared.sessionID')
  replace('assert.equal(yield* jobs.get(identity.jobID), undefined', 'diagnostic.stage = "job-duplicate-read";\n      assert.equal(yield* jobs.get(identity.jobID), undefined')
  replace('const accepted = yield* jobs.start(', 'diagnostic.stage = "job-start-awaiting-ACK";\n      const accepted = yield* jobs.start(')
  replace('assert.equal(accepted.status, "running")', 'diagnostic.stage = "job-start-returned";\n      assert.equal(accepted.status, "running");\n      diagnostic.admissionACKObserved = true')
  replace('Effect.scoped, Effect.catchCause(cause => Cause.hasInterruptsOnly(cause) ? Effect.interrupt\n      : Effect.fail(call.error("unavailable", "Native Job adoption fixture refused", {})))),',
    'Effect.tapCause(observeCause), Effect.scoped, Effect.catchCause(cause => {\n      try { captureFirstJobFailure(diagnostic, Cause.prettyErrors(cause), Cause.hasInterruptsOnly(cause)) } catch {}\n      return Cause.hasInterruptsOnly(cause) ? Effect.interrupt\n        : Effect.fail(call.error("unavailable", "Native Job adoption fixture refused", {}))\n    })) },')
  return source
}
