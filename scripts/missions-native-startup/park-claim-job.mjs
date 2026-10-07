// Park-only finite WAIT, not the qualified fresh-due graph helper or production authority.
import assert from "node:assert/strict"
import { appendFileSync } from "node:fs"
import path from "node:path"
import { Cause, Context, Effect, Exit, Predicate, Schema } from "effect"
import { JOB_TYPE } from "./job-contract.mjs"
import { captureFirstJobFailure, parkWatch } from "./park-claim-contract.mjs"
import { guarded, observeNative, readEnrollment, recordJobACK, reserveJobStart } from "./park-claim-stop-fence.mjs"

const jobsTag = Context.Service("@opencode/Job")
const callable = Schema.declare(Predicate.isFunction)
const jobsShape = Schema.Struct({ get: callable, start: callable, wait: callable, cancel: callable })
const infoShape = Schema.Struct({ id: Schema.String, type: Schema.String,
  status: Schema.Literals(["running", "completed", "error", "cancelled"]) })
const objectIDs = new WeakMap()
let sequence = 0
export const parkObjectID = object => {
  if (!objectIDs.has(object)) objectIDs.set(object, ++sequence)
  return objectIDs.get(object)
}
export const parkRecord = (kind, identity, facts) => {
  const file = process.env.NATIVE_STARTUP_MARKER
  const relative = path.relative(path.join(process.env.NATIVE_STARTUP_ROOT, "markers"), file)
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  const line = JSON.stringify({ kind, nonce: process.env.NATIVE_STARTUP_NONCE, pid: process.pid,
    at: Date.now(), ...identity, facts })
  assert.ok(line.length < 4096)
  appendFileSync(file, line + "\n", { mode: 0o600 })
}
const readIdentity = Effect.fn("fixture.parkIdentity")(function* (ctx, input, diagnostic, observe) {
  diagnostic.stage = "fixture-identity"
  const root = process.env.NATIVE_STARTUP_ROOT, nonce = process.env.NATIVE_STARTUP_NONCE
  const directory = path.join(root, "project")
  assert.equal(input.nonce, nonce)
  assert.equal(process.env.NATIVE_STARTUP_PERSISTED_NONCE, nonce)
  assert.equal(input.pid, process.pid)
  assert.equal(input.phase, "shutdown")
  assert.equal(typeof ctx.session.get, "function")
  diagnostic.stage = "enrollment-read"
  const enrolled = readEnrollment(root)
  assert.equal(typeof enrolled.permission.id, "string")
  parkWatch(enrolled, nonce, directory, input.sessionID)
  diagnostic.stage = "public-session-placement-read"
  const current = yield* ctx.session.get({ sessionID: input.sessionID })
  assert.equal(current.id, input.sessionID)
  assert.equal(current.parentID, undefined)
  assert.equal(current.agent, "build")
  assert.equal(path.resolve(current.location.directory), path.resolve(directory))
  assert.equal(current.location.workspaceID ?? null, ctx.location.workspaceID ?? null)
  parkWatch(enrolled, nonce, directory, input.sessionID) // Recheck absolute expiry after the awaited placement read.
  const binding = observe(enrolled)
  assert.equal(binding.sessionID, current.id)
  assert.equal(binding.hostPID, input.pid)
  assert.equal(binding.workspaceID, current.location.workspaceID ?? null)
  return Object.freeze({ ...binding, pid: process.pid })
})
// This factory captures ONLY frozen scalar identity; admission clears context before the native fork.
export const finiteParkWait = Effect.fn("fixture.finiteParkWait")(function* (identity) {
  const runScopeID = parkObjectID(yield* Effect.scope)
  assert.notEqual(runScopeID, identity.callerScopeID)
  assert.notEqual(runScopeID, identity.pluginScopeID)
  yield* Effect.addFinalizer(exit => Effect.sync(() => parkRecord("park-wait-finalized", identity,
    { runScopeID, exit: Exit.isSuccess(exit) ? "success" : Cause.hasInterruptsOnly(exit.cause) ? "interrupted" : "error" })))
  parkRecord("park-wait-start", identity, { runScopeID, deadlineAt: identity.deadlineAt, nativeOwnerScopeObserved: false })
  yield* Effect.sleep(Math.max(0, identity.deadlineAt - Date.now()))
  // Absolute sleep grants no right to publish: recheck the original claim/input under the Stop gate.
  return yield* guarded(identity.binding, "expiry", Effect.suspend(() => {
    assert.deepEqual(observeNative(readEnrollment(identity.root)), identity.binding)
    parkRecord("park-wait-expired", identity, { passageCompleted: false })
    return Effect.fail(new Error("Finite fixture wait expired without passage completion"))
  }))
}, Effect.scoped)
// Optional observer is a synthetic logic-test seam only; native entry uses the exact-root reader.
export const adoptParkJob = (ctx, input, pluginScopeID, lifecycle, observeNativeClaim = observeNative) => {
  const diagnostic = { stage: "service:Job", admissionACKObserved: false, jobsStartInvoked: false }
  const observeCause = cause => Effect.sync(() => {
    try { captureFirstJobFailure(diagnostic, Cause.prettyErrors(cause), Cause.hasInterruptsOnly(cause)) } catch {}
  })
  return Effect.gen(function* () {
    const jobs = yield* jobsTag
    diagnostic.serviceHandleIDs = { jobs: parkObjectID(jobs) }
    diagnostic.stage = "Job-callable-schema"
    Schema.decodeUnknownSync(jobsShape)(jobs)
    const declared = yield* readIdentity(ctx, input, diagnostic, observeNativeClaim)
    assert.equal(path.resolve(ctx.location.directory), path.resolve(declared.directory))
    assert.equal(lifecycle.isClosed(), false)
    const callerScopeID = parkObjectID(yield* Effect.scope)
    const { pid, ...binding } = declared
    const identity = Object.freeze({ ...declared, binding: Object.freeze(binding), pluginScopeID, callerScopeID })
    diagnostic.stage = "job-duplicate-read"
    assert.equal(yield* jobs.get(identity.jobID), undefined, "No duplicate live job or hidden admission retry")
    assert.deepEqual(yield* readIdentity(ctx, input, diagnostic, observeNativeClaim), declared, "Fixture identity changed during preparation")
    assert.equal(lifecycle.isClosed(), false)
    assert.ok(Date.now() < identity.deadlineAt, "Expired finite watch cannot be re-adopted")
    diagnostic.stage = "job-start-awaiting-ACK"
    const accepted = yield* guarded(binding, "adopt", Effect.suspend(() => {
      reserveJobStart(binding) // Charge before native start; unknown ACK cannot be retried.
      diagnostic.jobsStartInvoked = true
      return jobs.start({ id: identity.jobID, type: JOB_TYPE, title: "Unfinished finite fixture wait",
        run: finiteParkWait(identity) }).pipe(Effect.updateContext(() => Context.empty()))
    }))
    diagnostic.stage = "job-start-returned"
    const job = Schema.decodeUnknownSync(infoShape)(accepted)
    assert.equal(job.id, identity.jobID)
    assert.equal(job.type, JOB_TYPE)
    assert.equal(job.status, "running")
    diagnostic.admissionACKObserved = true
    diagnostic.stage = "job-registry-read-after-ACK"
    assert.deepEqual(Schema.decodeUnknownSync(infoShape)(yield* jobs.get(identity.jobID)), job)
    recordJobACK(binding) // Admission only, not execution or native owner proof.
    parkRecord("park-job-admitted", identity, { job, nativeJobsID: diagnostic.serviceHandleIDs.jobs })
    return { job, ids: { pluginScopeID, callerScopeID, nativeJobsID: diagnostic.serviceHandleIDs.jobs }, directory: identity.directory }
  }).pipe(Effect.tapCause(observeCause), Effect.scoped, Effect.catchCause(cause => {
    try { captureFirstJobFailure(diagnostic, Cause.prettyErrors(cause), Cause.hasInterruptsOnly(cause)) } catch {}
    return Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.die(new Error("Native Job admission refused; no retry"))
  }))
}
export const inspectParkJob = Effect.fn("fixture.inspectParkJob")(function* (ctx, input, observeNativeClaim = observeNative) {
  const jobs = yield* jobsTag
  Schema.decodeUnknownSync(jobsShape)(jobs)
  const identity = yield* readIdentity(ctx, input, { stage: "inspect" }, observeNativeClaim)
  const info = Schema.decodeUnknownSync(infoShape)(yield* jobs.get(identity.jobID))
  assert.equal(info.id, identity.jobID)
  assert.equal(info.type, JOB_TYPE)
  return info
})
