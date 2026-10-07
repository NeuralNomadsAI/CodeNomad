// Actual native Job.start adoption only. No Core imports, constructed layers or caller forks.
import assert from "node:assert/strict"
import { appendFileSync } from "node:fs"
import path from "node:path"
import { Cause, Context, Effect, Exit, MutableHashMap, Option, Predicate, Schema } from "effect"
import { Location } from "@opencode/schema/location"
import { readClaimEnrollment } from "./claim-plugin.mjs"
import { JOB_RPC, JOB_TYPE, jobID } from "./job-contract.mjs"
import emit from "./emit.cjs"

emit.module("job-plugin-module", import.meta.url)
const tags = { jobs: Context.Service("@opencode/Job"), map: Context.Service("@opencode/example/LocationServiceMap"),
  sessions: Context.Service("@opencode/Session"), location: Context.Service("@opencode/Location"),
  lifecycle: Context.Service("@opencode/LocationLifecycle"), permissions: Context.Service("@opencode/Permission"),
  agents: Context.Service("@opencode/Agent") }
const callable = Schema.declare(Predicate.isFunction)
const shapes = { jobs: Schema.Struct({ get: callable, start: callable, wait: callable, cancel: callable }),
  map: Schema.Struct({ contextEffect: callable, rcMap: Schema.Struct({ "~effect/RcMap": Schema.Literal("~effect/RcMap"),
    state: Schema.Struct({ _tag: Schema.Literal("Open"), map: Schema.declare(MutableHashMap.isMutableHashMap) }) }) }),
  sessions: Schema.Struct({ get: callable }), lifecycle: Schema.Struct({ isClosed: callable }), permissions: Schema.Struct({ ask: callable }),
  agents: Schema.Struct({ get: callable }) }
const objectIDs = new WeakMap()
let sequence = 0
const objectID = object => {
  assert.ok(object && (typeof object === "object" || typeof object === "function"))
  if (!objectIDs.has(object)) objectIDs.set(object, ++sequence)
  return objectIDs.get(object)
}
const entryFor = (map, ref) => map.rcMap.state._tag === "Open"
  ? Option.getOrUndefined(MutableHashMap.get(map.rcMap.state.map, ref)) : undefined
const observationKinds = new Set(["job-plugin-finalized", "job-caller-finalized", "job-run-start", "job-run-finalized",
  "job-admitted", "job-fresh-acquire", "job-due-marker", "job-inspected"])
function record(kind, identity, facts) {
  assert.ok(observationKinds.has(kind))
  const root = process.env.NATIVE_STARTUP_ROOT, file = process.env.NATIVE_STARTUP_MARKER, nonce = process.env.NATIVE_STARTUP_NONCE
  const relative = path.relative(path.join(root, "markers"), file)
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  const line = JSON.stringify({ kind, nonce, pid: process.pid, at: Date.now(), directory: identity.directory,
    sessionID: identity.sessionID, jobID: identity.jobID, facts })
  assert.ok(line.length < 4096)
  appendFileSync(file, `${line}\n`, { mode: 0o600 })
}
const pickJob = info => {
  assert.ok(info && ["running", "completed", "error", "cancelled"].includes(info.status))
  return { id: info.id, type: info.type, status: info.status, ...(info.output === undefined ? {} : { output: info.output }) }
}

// This top-level factory captures ONLY actual global services and frozen scalar fixture identity.
// It never closes over plugin ctx, origin graph/lease, caller Scope or Location services.
const runOwnedJob = Effect.fn("fixture.globalJobRun")(function* (jobs, map, sessions, identity) {
  let step = "run-context"
  const runScope = yield* Effect.scope
  const runScopeID = objectID(runScope)
  assert.ok(Option.isNone(yield* Effect.serviceOption(tags.location)), "Run context must not expose the origin Location graph")
  assert.ok(Option.isNone(yield* Effect.serviceOption(tags.lifecycle)), "Run context must not expose the origin lifecycle")
  assert.notEqual(runScopeID, identity.callerScopeID)
  assert.notEqual(runScopeID, identity.pluginScopeID)
  yield* Effect.addFinalizer(exit => Effect.sync(() => record("job-run-finalized", identity,
    { runScopeID, step, exit: Exit.isSuccess(exit) ? "success" : Cause.hasInterruptsOnly(exit.cause) ? "cancelled" : "error",
      errors: Exit.isFailure(exit) ? Cause.prettyErrors(exit.cause).map(error => ({ name: error.name, message: error.message.slice(0, 1000) })) : [] })))
  record("job-run-start", identity, { runScopeID, nativeJobsID: objectID(jobs), delayMs: identity.delayMs })
  yield* Effect.sleep(identity.delayMs)
  step = "fresh-session-placement"
  const current = yield* sessions.get(identity.sessionID)
  assert.equal(current.id, identity.sessionID)
  assert.equal(current.location.directory, identity.directory, "Moved fixture placement denies instead of root inference")
  assert.equal(current.location.workspaceID ?? null, identity.workspaceID)
  const ref = Location.Ref.make({ directory: path.normalize(current.location.directory), workspaceID: current.location.workspaceID })
  assert.equal(entryFor(map, ref), undefined, "Exact evicted fixture root must be cold before the one acquire")
  step = "one-scoped-cold-acquire"
  return yield* Effect.gen(function* () {
    const graph = yield* map.contextEffect(ref)
    step = "fresh-graph-contract"
    assert.ok(Context.isContext(graph))
    const entry = entryFor(map, ref)
    assert.ok(entry)
    const origin = Context.get(graph, tags.location), lifecycle = Context.get(graph, tags.lifecycle)
    Schema.decodeUnknownSync(shapes.lifecycle)(lifecycle)
    assert.equal(origin.directory, identity.directory)
    assert.equal(lifecycle.isClosed(), false)
    assert.notEqual(objectID(entry), identity.oldEntryTokenID)
    assert.notEqual(objectID(entry.scope), identity.oldEntryScopeID)
    assert.notEqual(objectID(lifecycle), identity.originLifecycleID)
    const refreshed = yield* sessions.get(identity.sessionID)
    assert.equal(refreshed.location.directory, identity.directory)
    assert.equal(refreshed.location.workspaceID ?? null, identity.workspaceID)
    const permissions = Context.get(graph, tags.permissions)
    Schema.decodeUnknownSync(shapes.permissions)(permissions)
    const agents = Context.get(graph, tags.agents)
    Schema.decodeUnknownSync(shapes.agents)(agents)
    step = "bounded-fresh-policy-readiness"
    let agentReads = 0, ready = false
    for (; agentReads < 40; agentReads++) {
      const agent = yield* agents.get("build")
      ready = agent?.permissions.findLast(rule => ["*", "fixture_hold"].includes(rule.action)
        && ["*", identity.nonce].includes(rule.resource))?.effect === "allow"
      if (ready) break
      yield* Effect.sleep(50)
    }
    assert.ok(ready, "Fresh graph's read-only policy demand must settle before the one native permission evaluation")
    step = "fresh-native-permission"
    const allowed = yield* permissions.ask({ sessionID: identity.sessionID, action: "fixture_hold", resources: [identity.nonce], save: [], agent: "build" })
    assert.equal(allowed.effect, "allow")
    assert.equal(entryFor(map, ref), entry)
    assert.equal(lifecycle.isClosed(), false)
    record("job-fresh-acquire", identity, { entryTokenID: objectID(entry), entryScopeID: objectID(entry.scope),
      originLifecycleID: objectID(lifecycle), leaseScopeID: objectID(yield* Effect.scope), nativeMapID: objectID(map),
      nativeSessionID: objectID(sessions), nativePermissionID: allowed.id, agentReads: agentReads + 1 })
    record("job-due-marker", identity, { allowlistedEffect: "one-owned-nonce-marker", entryTokenID: objectID(entry) })
    step = "one-marker-complete"
    return "one-owned-nonce-marker"
  }).pipe(Effect.scoped)
}, Effect.scoped)

export default { id: "missions.native-claim-fixture", effect: Effect.fn("fixture.jobPlugin")(function* (ctx) {
  const root = process.env.NATIVE_STARTUP_ROOT, nonce = process.env.NATIVE_STARTUP_NONCE, directory = ctx.location.directory
  assert.ok(["project", "idle-project"].some(name => path.resolve(root, name) === path.resolve(directory)))
  const pluginScope = yield* Effect.scope
  const pluginScopeID = objectID(pluginScope)
  let originProof
  emit("claim-plugin-setup", directory)
  yield* Effect.addFinalizer(() => Effect.sync(() => {
    record("job-plugin-finalized", { directory }, { pluginScopeID,
      originLifecycleClosed: originProof?.lifecycle.isClosed() ?? null,
      entryScopeState: originProof?.entry.scope.state._tag ?? null, entryTokenID: originProof && objectID(originProof.entry) })
    originProof = undefined
  }))
  const services = Effect.fn("fixture.nativeJobServices")(function* () {
    const jobs = yield* tags.jobs, map = yield* tags.map, sessions = yield* tags.sessions
    Schema.decodeUnknownSync(shapes.jobs)(jobs)
    Schema.decodeUnknownSync(shapes.map)(map)
    Schema.decodeUnknownSync(shapes.sessions)(sessions)
    return { jobs, map, sessions }
  })
  const identityFor = Effect.fn("fixture.jobIdentity")(function* (input, sessions) {
    assert.equal(input.nonce, nonce)
    assert.equal(input.pid, process.pid)
    const declared = path.join(root, "project")
    const enrolled = yield* Effect.promise(() => readClaimEnrollment(input, { sessionID: input.sessionID }, declared))
    const current = yield* sessions.get(input.sessionID)
    assert.equal(current.location.directory, declared)
    const id = jobID(nonce, input.phase)
    assert.notEqual(id, input.sessionID)
    return Object.freeze({ nonce, sessionID: input.sessionID, directory: declared,
      workspaceID: current.location.workspaceID ?? null, jobID: id, phase: input.phase, enrollmentPermissionID: enrolled.permission.id })
  })
  yield* ctx.rpc.register(JOB_RPC, {
    start: (input, call) => Effect.gen(function* () {
      const { jobs, map, sessions } = yield* services()
      const declared = yield* identityFor(input, sessions)
      assert.equal(directory, declared.directory)
      const origin = yield* tags.location, lifecycle = yield* tags.lifecycle, permissions = yield* tags.permissions
      Schema.decodeUnknownSync(shapes.lifecycle)(lifecycle)
      Schema.decodeUnknownSync(shapes.permissions)(permissions)
      assert.equal(origin.directory, directory)
      assert.equal(lifecycle.isClosed(), false)
      const ref = Location.Ref.make({ directory: path.normalize(directory), workspaceID: origin.workspaceID })
      const entry = entryFor(map, ref)
      assert.ok(entry)
      originProof = { entry, lifecycle } // confined to the plugin's finalizer, NOT captured by runOwnedJob
      const callerScopeID = objectID(yield* Effect.scope)
      assert.notEqual(callerScopeID, pluginScopeID)
      yield* Effect.addFinalizer(() => Effect.sync(() => record("job-caller-finalized", declared, { callerScopeID })))
      const allowed = yield* permissions.ask({ sessionID: declared.sessionID, action: "fixture_hold", resources: [nonce], save: [], agent: "build" })
      assert.equal(allowed.effect, "allow")
      const ids = { callerScopeID, pluginScopeID, oldEntryTokenID: objectID(entry), oldEntryScopeID: objectID(entry.scope),
        originLifecycleID: objectID(lifecycle), nativeJobsID: objectID(jobs), nativeMapID: objectID(map), nativeSessionID: objectID(sessions) }
      const identity = Object.freeze({ ...declared, ...ids, delayMs: input.phase === "due" ? 20_000 : 90_000 })
      assert.equal(yield* jobs.get(identity.jobID), undefined, "No duplicate live job or hidden admission retry")
      const actualGlobals = Context.make(tags.jobs, jobs).pipe(Context.add(tags.map, map), Context.add(tags.sessions, sessions))
      const accepted = yield* jobs.start({ id: identity.jobID, type: JOB_TYPE, title: "Bounded native owner qualification",
        metadata: { fixtureNonce: nonce, phase: input.phase },
        run: runOwnedJob(jobs, map, sessions, identity).pipe(Effect.updateContext(() => actualGlobals)) })
      assert.equal(accepted.status, "running")
      assert.equal(entryFor(map, ref), entry)
      assert.equal(lifecycle.isClosed(), false)
      record("job-admitted", identity, { ...ids, nativePermissionID: allowed.id, status: accepted.status })
      return { job: pickJob(accepted), ids, directory }
    }).pipe(Effect.scoped, Effect.catchCause(cause => Cause.hasInterruptsOnly(cause) ? Effect.interrupt
      : Effect.fail(call.error("unavailable", "Native Job adoption fixture refused", {})))),
    inspect: input => Effect.gen(function* () {
      const { jobs, sessions } = yield* services()
      const identity = yield* identityFor(input, sessions)
      const info = yield* jobs.get(identity.jobID)
      assert.equal(info?.id, identity.jobID)
      assert.equal(info?.type, JOB_TYPE)
      record("job-inspected", identity, { status: info.status, nativeJobsID: objectID(jobs) })
      return pickJob(info)
    }),
    wait: input => Effect.gen(function* () {
      const { jobs, sessions } = yield* services()
      const identity = yield* identityFor(input, sessions)
      const waited = yield* jobs.wait({ id: identity.jobID, timeout: 1_000 })
      assert.equal(waited.timedOut, false)
      return pickJob(waited.info)
    }),
  })
}) }
