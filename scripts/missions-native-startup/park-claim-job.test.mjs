// Real Effect, fake Job methods: zero native authority, owner-Scope or admission qualification.
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Cause, Context, Effect, Option } from "effect"
import { adoptParkJob, finiteParkWait, inspectParkJob, parkObjectID } from "./park-claim-job.mjs"
import { adaptJobHelper, captureFirstJobFailure, WATCH_MS } from "./park-claim-contract.mjs"
import { bindGeneration, decodeBinding } from "./park-claim-stop-fence.mjs"
import { JOB_TYPE, jobID } from "./job-contract.mjs"

const root = await mkdtemp("C:/Users/Admin/AppData/Local/Temp/opencode/park-jobs-only-check-")
await mkdir(path.join(root, "markers"))
const nonce = "00000000-0000-4000-8000-000000000002", sessionID = "fixture-owned-session", directory = path.join(root, "project")
Object.assign(process.env, { NATIVE_STARTUP_ROOT: root, NATIVE_STARTUP_NONCE: nonce,
  NATIVE_STARTUP_PERSISTED_NONCE: nonce, NATIVE_STARTUP_MARKER: path.join(root, "markers/check.jsonl") })
const createdAt = Date.now(), deadlineAt = createdAt + WATCH_MS
const enrollment = { nonce, directory, sessionID, permission: { id: "fixture-permission", effect: "allow" }, watch: {
  createdAt, deadlineAt, pendingID: `finite_watch_${nonce.replaceAll("-", "")}`,
  intent: "one finite authorized watch; park twice; no passage completion" } }
const binding = decodeBinding({ version: 1, nonce, root, directory, sessionID,
  inputID: `msg_park_${nonce.replaceAll("-", "")}`, pendingID: enrollment.watch.pendingID,
  permissionID: enrollment.permission.id, createdAt, deadlineAt, claimAt: createdAt + 1,
  inputHash: "a".repeat(64), dbPath: path.join(root, "fixture.db"), dbIdentity: "b".repeat(64),
  executable: path.join(root, "native-executable"), executableIdentity: "c".repeat(64),
  projectID: "fixture-project", workspaceID: null, generation: 1, hostPID: process.pid,
  jobID: jobID(nonce, "shutdown") })
bindGeneration(binding) // Synthetic exact-root observation only; no native database opened.
const enroll = value => writeFile(path.join(root, "claim-enrollment.json"), JSON.stringify(value))
await enroll(enrollment)
const trace = [], infos = new Map()
const originTag = Context.Service("fixture/Origin"), origin = Object.freeze({ label: "caller-only" })
let captured, placement = { id: sessionID, agent: "build", location: { directory }, parentID: undefined }
const fakeJobs = {
  get: id => { trace.push(["get", id]); return Effect.succeed(infos.get(id)) },
  start: input => {
    trace.push(["start", input.id]); captured = input
    const info = { id: input.id, type: input.type, status: "running" }
    infos.set(input.id, info)
    return Effect.gen(function* () {
      // Inspect BEFORE a native-style internal fork could inherit the admission Context.
      assert.equal((yield* Effect.context()).mapUnsafe.size, 0)
      assert.equal(Option.isNone(yield* Effect.serviceOption(originTag)), true)
      return info
    })
  },
  wait: () => Effect.die(new Error("Unexpected fake wait")), cancel: () => Effect.die(new Error("Unexpected fake cancel")),
}
const jobsTag = Context.Service("@opencode/Job")
const ctx = { location: { directory }, session: { get: input => {
  assert.deepEqual(input, { sessionID }); return Effect.succeed(placement)
} } }
const input = { nonce, sessionID, pid: process.pid, phase: "shutdown" }
const lifecycle = { isClosed: () => false }
// Same services omitted as the observed native hook. The old helper still fails at Map, before any Job method.
const oldSource = adaptJobHelper(await readFile(new URL("job-plugin.mjs", import.meta.url), "utf8"))
const services = oldSource.slice(oldSource.indexOf('const services = Effect.fn'), oldSource.indexOf('  const identityFor ='))
const handler = oldSource.slice(oldSource.indexOf('start: (input, call) =>') + 7, oldSource.indexOf(',\n    inspect:'))
const oldStart = new Function("Effect", "Cause", "tags", "captureFirstJobFailure", "objectID", `${services}; return (${handler})`)(
  Effect, Cause, { jobs: jobsTag, map: Context.Service("@opencode/example/LocationServiceMap"), sessions: Context.Service("@opencode/Session") },
  captureFirstJobFailure, parkObjectID)
const oldExit = await Effect.runPromiseExit(oldStart(input, { error: () => { throw new Error("Opaque old refusal") } }).pipe(Effect.provideService(jobsTag, fakeJobs)))
assert.equal(Cause.prettyErrors(oldExit.cause)[0].message, "Opaque old refusal")
assert.equal(trace.length, 0)
const oldMarker = JSON.parse((await readFile(process.env.NATIVE_STARTUP_MARKER, "utf8")).trim())
assert.equal(oldMarker.facts.errors[0].message, "Service not found: @opencode/example/LocationServiceMap")

const admit = () => Effect.scoped(Effect.gen(function* () {
  const pluginScopeID = parkObjectID(yield* Effect.scope)
  const admitted = yield* adoptParkJob(ctx, input, pluginScopeID, lifecycle, () => binding)
  assert.equal(yield* originTag, origin) // Only the short start boundary clears the caller Context.
  return admitted
})).pipe(Effect.provideService(jobsTag, fakeJobs), Effect.provideService(originTag, origin))
const result = await Effect.runPromise(admit())
assert.deepEqual(result.job, { id: jobID(nonce, "shutdown"), type: JOB_TYPE, status: "running" })
assert.deepEqual(trace.map(entry => entry[0]), ["get", "start", "get"])
assert.equal(captured.recovery, undefined)
assert.equal(captured.notificationID, undefined)
assert.equal((await Effect.runPromise(inspectParkJob(ctx, input, () => binding).pipe(Effect.provideService(jobsTag, fakeJobs)))).status, "running")
// The recorded wait is ordinary Effect only; interrupt locally, not a native Job.cancel/owner proof.
await Effect.runPromise(captured.run.pipe(Effect.timeoutOption(5)))
let markers = (await readFile(process.env.NATIVE_STARTUP_MARKER, "utf8")).trim().split("\n").map(JSON.parse)
const runStart = markers.find(marker => marker.kind === "park-wait-start")
assert.equal(runStart.facts.deadlineAt, deadlineAt)
assert.notEqual(runStart.facts.runScopeID, result.ids.pluginScopeID)
assert.notEqual(runStart.facts.runScopeID, result.ids.callerScopeID)
assert.equal(markers.some(marker => marker.kind === "park-wait-expired"), false)
// Empty context still has the default Clock and excludes arbitrary caller services. No Layer is constructed.
await Effect.runPromise(Effect.gen(function* () {
  assert.equal(Option.isNone(yield* Effect.serviceOption(originTag)), true)
  yield* Effect.sleep(1)
}).pipe(Effect.updateContext(() => Context.empty()), Effect.provideService(originTag, {})))

const refuse = async effect => {
  const startsBefore = trace.filter(entry => entry[0] === "start").length
  const exit = await Effect.runPromiseExit(effect)
  assert.equal(Cause.prettyErrors(exit.cause)[0].message, "Native Job admission refused; no retry")
  assert.equal(trace.filter(entry => entry[0] === "start").length, startsBefore)
}
await refuse(admit()) // Duplicate is never retried.
infos.clear()
let placementReads = 0
await refuse(adoptParkJob({ ...ctx, session: { get: () => Effect.succeed(++placementReads === 1 ? placement
  : { ...placement, location: { directory: directory + "-moved" } }) } }, input, 1, lifecycle, () => binding)
  .pipe(Effect.provideService(jobsTag, fakeJobs)))
assert.equal(placementReads, 2)
await refuse(adoptParkJob(ctx, input, 1, lifecycle, () => binding).pipe(Effect.provideService(jobsTag, { ...fakeJobs, cancel: false })))
placement = { ...placement, location: { directory: directory + "-moved" } }
await refuse(admit())
placement = { ...placement, location: { directory }, parentID: "other-parent" }
await refuse(admit())
placement = { ...placement, parentID: undefined }
await enroll({ ...enrollment, permission: { id: "fixture-permission", effect: "deny" } })
await refuse(admit())
const expiredAt = Date.now() - 1
await enroll({ ...enrollment, watch: { ...enrollment.watch, createdAt: expiredAt - WATCH_MS, deadlineAt: expiredAt } })
await refuse(admit())
await enroll(enrollment)
await refuse(adoptParkJob(ctx, { ...input, pid: process.pid + 1 }, 1, lifecycle, () => binding).pipe(Effect.provideService(jobsTag, fakeJobs)))
await refuse(adoptParkJob(ctx, input, 1, { isClosed: () => true }, () => binding).pipe(Effect.provideService(jobsTag, fakeJobs)))
markers = (await readFile(process.env.NATIVE_STARTUP_MARKER, "utf8")).trim().split("\n").map(JSON.parse)
assert.ok(markers.filter(marker => marker.kind === "park-helper-first-cause" && "jobsStartInvoked" in marker.facts)
  .every(marker => marker.facts.jobsStartInvoked === false && marker.facts.admissionACKObserved === false))
// A separate first generation reaches start, loses its ACK, then refuses a retry.
const unknownRoot = await mkdtemp("C:/Users/Admin/AppData/Local/Temp/opencode/park-jobs-only-check-")
await mkdir(path.join(unknownRoot, "markers"))
const unknownDirectory = path.join(unknownRoot, "project")
const unknownBinding = decodeBinding({ ...binding, root: unknownRoot, directory: unknownDirectory,
  dbPath: path.join(unknownRoot, "fixture.db") })
bindGeneration(unknownBinding)
await writeFile(path.join(unknownRoot, "claim-enrollment.json"), JSON.stringify({ ...enrollment, directory: unknownDirectory }))
process.env.NATIVE_STARTUP_ROOT = unknownRoot
process.env.NATIVE_STARTUP_MARKER = path.join(unknownRoot, "markers/check.jsonl")
const unknownCtx = { location: { directory: unknownDirectory }, session: { get: () => Effect.succeed({
  id: sessionID, agent: "build", location: { directory: unknownDirectory }, parentID: undefined,
}) } }
let unknownStarts = 0
const unknownJobs = { ...fakeJobs, start: () => { unknownStarts++; return Effect.fail(new Error("authorization=secret unknown native start effect")) } }
const unknownAdmit = () => adoptParkJob(unknownCtx, input, 1, lifecycle, () => unknownBinding).pipe(Effect.provideService(jobsTag, unknownJobs))
await refuse(unknownAdmit())
markers = (await readFile(process.env.NATIVE_STARTUP_MARKER, "utf8")).trim().split("\n").map(JSON.parse)
assert.equal(unknownStarts, 1)
assert.equal(markers.at(-1).facts.jobsStartInvoked, true)
assert.equal(markers.at(-1).facts.admissionACKObserved, false)
assert.ok(!JSON.stringify(markers).includes("secret"))
await refuse(unknownAdmit())
assert.equal(unknownStarts, 1)
// Actual expiry with a Stop fence is exercised in park-claim-stop-fence.test.mjs.
console.log(JSON.stringify({ root, passed: 5, nativeOperations: 0, fakeJobsOnly: true, nativeAdmissionQualified: false,
  oldHelperStillMissingMap: true, jobsOnlyHelperInputCaptured: true, fixedAbsoluteDeadline: true,
  emptyContextAtStartBeforeInternalFork: true, callerContextRestoredAfterStart: true,
  emptyContextDefaultClockWorks: true, invalidAuthorityPlacementShapeAndDuplicateRefusedWithoutStart: true }))
