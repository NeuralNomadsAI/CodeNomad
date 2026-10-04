import assert from "node:assert/strict"
import test from "node:test"
import { fixture as protectedFixture } from "./host-authority/test-fixture"
import { MissionJournal, parseMissionEvent, type MissionStorage } from "./journal"
import { MISSION_SCHEMA_VERSION, type MissionEvent, type MissionJsonValue, type MissionTask, type MissionTemplateId } from "./model"
import { authorityDigest, canonicalAuthority, type AuthorityRoot } from "./authority-protocol"
import { DerivedCallAuthority } from "./derived-call-authority"
import { derivedReservationID, type DerivedCallBody, type DerivedInvocationPurpose, type DerivedInvocationVerifier } from "./derived-call-protocol"
import { SharedJournalDerivedCallBusiness, derivedNativeBinding, derivedTaskContractDigest,
  type DerivedBusinessChannel, type DerivedNativeChildObservation } from "./derived-call-business"
import { DerivedCallPublication, type DerivedCallPublicationContext, type DerivedCallPublicationChannel } from "./derived-call-publication"
import type { MissionNativeReportRequest } from "./control-types"

export const freshSignal = () => new AbortController().signal
const portable = <T>(value: T): T => JSON.parse(JSON.stringify(value))

/** STRUCTURAL trust injection only. Actual shared MissionJournal/reducer, crypto,
 * protected host and native authority metadata; Map-backed sync reads/leases are
 * explicitly NOT real-host/native writer, provider or physical-family proof. */
export async function structuralDerivedFixture(template: MissionTemplateId = "custom") {
  const f = await protectedFixture()
  await f.prepare(); await f.execute(await f.body("adopt", {})); await f.execute(await f.body("lifecycle", { action: "start" }))
  let authorityDoc = await f.core.store.read()
  const values = new Map<string, MissionJsonValue>(), children = new Map<string, DerivedNativeChildObservation>()
  const profiles = new Map<string, DerivedNativeChildObservation["execution"]>()
  let claim = true, idle = true, nativeObserved = true, root: AuthorityRoot = f.target.roots[0]
  let beforeWrite: (() => void | Promise<void>) | undefined, afterWrite: (() => void) | undefined
  let resolverHook: (() => void | Promise<void>) | undefined, idleReads = 0
  const storage: MissionStorage = {
    async get(key) { return structuredClone(values.get(key)) },
    async set(key, value, current) {
      await beforeWrite?.()
      current?.() // repeats the journal fence AFTER the policy-backed write await
      values.set(key, structuredClone(value)); afterWrite?.()
    },
    async scan({ prefix, after, limit = 100 }) {
      const keys = [...values.keys()].filter(key => key.startsWith(prefix) && (!after || key > after)).sort()
      const page = keys.slice(0, limit)
      return { entries: page.map(key => ({ key, value: structuredClone(values.get(key)!) })), ...(keys.length > limit ? { next: page.at(-1) } : {}) }
    },
  }
  const journal = new MissionJournal(storage, f.target.projectID, f.project)
  const readSync = () => {
    const events: MissionEvent[] = []; let discardedEvents = 0
    for (const value of values.values()) { const event = parseMissionEvent(value); if (event) events.push(event); else discardedEvents++ }
    return { events, discardedEvents }
  }
  const base = () => { const createdAt = Math.max(0, ...readSync().events.map(event => event.createdAt)) + 1
    return { version: MISSION_SCHEMA_VERSION, id: `evt_${createdAt}`, createdAt, projectID: f.target.projectID, missionID: f.target.missionID } }
  await journal.append({ ...base(), type: "mission.created", projectCanonical: f.project, objective: "Shared native tasks", template,
    coordinator: { sessionID: f.target.coordinatorSessionID, title: "Coordinator", location: { directory: f.project } } })
  const mission = async () => (await journal.snapshot()).missions[0]
  const execution = { agent: "worker", model: { providerID: "fixture", id: "model", variant: "careful" } }
  const task = async (key: string, options: Partial<MissionTask> = {}) => {
    await journal.append({ ...base(), type: "task.created", task: portable({ id: `tsk_${key}`, key, title: key, brief: `Brief ${key}`, role: "worker",
      blockedBy: [], execution, executionMode: { kind: "native", parentTaskKey: null }, ...options }) })
  }
  const body = async (key = "work", options: Partial<DerivedCallBody> = {}) => {
    const current = await mission(), own = current.tasks.find(task => task.key === key)!
    const host = (await f.host.read())!, mode = own.executionMode
    const parent = mode?.kind === "native" && mode.parentTaskKey ? current.tasks.find(task => task.key === mode.parentTaskKey) : undefined
    const { reservationID: _, ...overrides } = options
    const identity: Omit<DerivedCallBody, "reservationID"> = { ...host.binding, version: 1, policy: "codenomad.missions.native-call/signed-v1",
      epoch: host.mirror!.epoch, provisioningGeneration: host.signer!.provisioningGeneration, signerDigest: host.signer!.signerDigest,
      task: { taskKey: own.key, generation: own.contractGeneration! }, taskContractDigest: derivedTaskContractDigest(current, own),
      parentTask: parent ? { taskKey: parent.key, generation: parent.contractGeneration! } : null,
      parentSessionID: parent?.actorSessionId ?? host.binding.coordinatorSessionID, parentMessageID: `msg_${key}`, toolCallID: `call_${key}`,
      choice: { kind: "new" }, execution: portable(own.execution ?? {}), root: f.target.roots[0], ...overrides }
    return { ...identity, reservationID: derivedReservationID(identity) }
  }
  const assertClaim = (): true => { if (!claim) throw new Error("injected structural claim lost"); return true }
  const readChild = (id: string, value: DerivedCallBody, purpose: DerivedInvocationPurpose) => {
    const child = children.get(id); if (!child) throw new Error("unknown actual fixture native child")
    return { ...structuredClone(child), executionObserved: nativeObserved,
      ...((purpose === "report" || purpose === "end") && profiles.has(value.reservationID) ? { execution: structuredClone(profiles.get(value.reservationID)!) } : {}) }
  }
  const channel: DerivedBusinessChannel = {
    assertCurrent: assertClaim,
    readCurrentJournal(owned) { assert.equal(owned, journal); assertClaim(); return readSync() },
    readCurrentAuthority(owned) { assert.equal(owned, f.core.store); assertClaim(); return structuredClone(authorityDoc) },
    async readChild(id, input) { assertClaim(); return readChild(id, input.body, input.purpose) },
    readChildCurrent(id, input) { assertClaim(); return readChild(id, input.body, input.purpose) },
    async resolveRoot() { await resolverHook?.(); assertClaim(); return { root: structuredClone(root), assertCurrent: assertClaim } },
    resolveRootCurrent() { assertClaim(); return structuredClone(root) },
    async assertNativeIdle(input) { assertClaim(); input.signal.throwIfAborted(); idleReads++; if (!idle) throw new Error("full family busy/forms/permission/Shell"); return true },
    assertNativeIdleCurrent() { assertClaim(); if (!idle) throw new Error("full family became busy"); return true },
  }
  const business = new SharedJournalDerivedCallBusiness({ journal, store: f.core.store, host: f.host, channel })
  type FixtureProof = { body: DerivedCallBody; purpose: DerivedInvocationPurpose; childSessionID?: string; outcome?: "returned" | "error";
    nonce: string; incarnationID: string; request?: MissionNativeReportRequest }
  const proofs = new WeakMap<object, FixtureProof>()
  const context = (value: DerivedCallBody, purpose: DerivedInvocationPurpose, childSessionID?: string,
    outcome?: "returned" | "error", request?: MissionNativeReportRequest): DerivedCallPublicationContext => {
    const proof = Object.freeze({}), nonce = `injected_${value.reservationID}_${purpose}`, incarnationID = "injected-structural-writer-only"
    proofs.set(proof, { body: structuredClone(value), purpose, childSessionID, outcome, nonce, incarnationID, request })
    return { nonce, incarnationID, proof }
  }
  const known = (input: DerivedCallPublicationContext) => {
    const facts = typeof input.proof === "object" && input.proof ? proofs.get(input.proof) : undefined
    if (!facts || facts.nonce !== input.nonce || facts.incarnationID !== input.incarnationID) throw new Error("unknown actual fixture channel invocation")
    return facts
  }
  const verifier: DerivedInvocationVerifier = { async verify(input) {
    const facts = known(input.proof as DerivedCallPublicationContext)
    return { bodyDigest: authorityDigest(facts.body), purpose: facts.purpose, childSessionID: facts.childSessionID, outcome: facts.outcome,
      callerSessionID: facts.purpose === "execute" || facts.purpose === "report" ? facts.childSessionID! : facts.body.parentSessionID, assertCurrent: assertClaim }
  } }
  const authority = new DerivedCallAuthority({ store: f.core.store, host: f.host, native: f.core, business, invocations: verifier })
  const forwarded: Array<Parameters<DerivedCallPublicationChannel["authorize"]>[0]> = []
  const publicationChannel: DerivedCallPublicationChannel = { async authorize(input) {
    const facts = known(input); forwarded.push(input)
    if (facts.purpose !== input.purpose || facts.childSessionID !== input.childSessionID || facts.outcome !== input.outcome
      || authorityDigest(facts.body) !== authorityDigest(input.record.signed.body)
      || input.reportRequest && JSON.stringify(input.reportRequest) !== JSON.stringify(facts.request)) throw new Error("wrong original native invocation")
    const current = (): true => {
      assertClaim(); f.host.assertDerivedEvidence(input.record.signed)
      if (input.purpose === "bind") f.host.assertHostGrantCurrent(authorityDoc.grants[0])
      return true
    }
    current(); return { assertCurrent: current }
  } }
  const publication = new DerivedCallPublication({ authority, business, channel: publicationChannel })
  const refresh = async () => { authorityDoc = await f.core.store.read() }
  const request = (value: DerivedCallBody, purpose: "bind" | "end", id = "ses_child", outcome?: "returned" | "error") => ({
    ...context(value, purpose, id, outcome), reservationID: value.reservationID, childSessionID: id })
  const start = async (value: DerivedCallBody) => {
    await authority.reserve(value, context(value, "reserve"), freshSignal()); await refresh()
    const admission = await authority.admitNative(value.reservationID, context(value, "reserve"), freshSignal()); admission.assertCurrent(); await refresh()
  }
  const native = (value: DerivedCallBody, id = "ses_child") => {
    children.set(id, { sessionID: id, parentSessionID: value.parentSessionID, projectID: value.projectID,
      title: "Actual child", location: { directory: f.project }, execution: structuredClone(execution), executionObserved: true })
    profiles.set(value.reservationID, structuredClone(execution))
  }
  const bind = async (value: DerivedCallBody, id = "ses_child") => {
    native(value, id); const input = request(value, "bind", id)
    await publication.publishBinding(input, freshSignal()); await publication.activateBinding(input, freshSignal()); await refresh()
  }
  const end = async (value: DerivedCallBody, id = "ses_child", outcome: "returned" | "error" = "returned") => {
    const input = { ...request(value, "end", id, outcome), outcome }
    await publication.publishEnd(input, freshSignal()); await publication.endAuthority(input, freshSignal()); await refresh()
  }
  const report = async (value: DerivedCallBody, id = "ses_child", artifact?: MissionJsonValue) => {
    const event = base()
    await journal.append({ ...event, type: "task.reported", report: { id: `rpt_${event.id}`, taskKey: value.task.taskKey, sessionId: id,
      outcome: "completed", summary: "Explicit report", evidence: ["observed"], next: [], createdAt: event.createdAt,
      nativeCall: derivedNativeBinding(value), delivery: "native-return", ...(artifact ? { artifact } : {}) } })
  }
  const seedCompleted = async (key: string, role: string, blockedBy: string[], id: string, artifact?: MissionJsonValue, options: Partial<MissionTask> = {}) => {
    await task(key, { role, blockedBy, ...options }); const value = await body(key), existing = (await mission()).actors.find(actor => actor.sessionId === id)
    await journal.append({ ...base(), type: "task.native-bound", taskKey: key, binding: derivedNativeBinding(value),
      actor: { sessionID: id, title: existing?.title ?? key, location: existing?.location ?? { directory: f.project }, managed: existing?.managed ?? false } })
    await report(value, id, artifact)
    await journal.append({ ...base(), type: "task.native-returned", taskKey: key, binding: derivedNativeBinding(value), childSessionID: id })
    native(value, id)
    return value
  }
  return { f, journal, values, children, profiles, channel, business, authority, publication, publicationChannel, forwarded,
    base, task, body, mission, context, request, refresh, start, native, bind, end, report, seedCompleted,
    setClaim(value: boolean) { claim = value }, setIdle(value: boolean) { idle = value }, idleReads: () => idleReads,
    setObserved(value: boolean) { nativeObserved = value }, setRoot(value: AuthorityRoot) { root = value },
    beforeWrite(hook?: () => void | Promise<void>) { beforeWrite = hook }, afterWrite(hook?: () => void) { afterWrite = hook },
    resolverHook(hook?: () => void | Promise<void>) { resolverHook = hook } }
}

const artifacts: Record<string, MissionJsonValue> = {
  diagnostician: { kind: "diagnosis", feedbackLoop: { command: "fixture test", redOutput: "red" }, minimizedRepro: "repro",
    confirmedHypothesis: "cause", evidence: "observed", rejectedHypotheses: [] },
  implementer: { kind: "fix", changedFiles: ["fixture.ts"], regressionTest: { seam: "present", path: "fixture.test.ts", command: "fixture test",
    redObserved: true, greenObserved: true }, originalLoopGreen: true, debugInstrumentationRemoved: true, prevention: "fixture regression" },
  "review-standards": { kind: "review", axis: "standards", verdict: "pass", findings: [] },
  "review-spec": { kind: "review", axis: "spec", verdict: "pass", findings: [] },
  resolver: { kind: "resolution", addressed: [], deferred: [], focusedChecks: [{ command: "fixture test", passed: true }] },
}
async function seedPocock(g: Awaited<ReturnType<typeof structuralDerivedFixture>>, standardsID = "ses_standards", specID = "ses_spec") {
  await g.seedCompleted("diagnose", "diagnostician", [], "ses_diagnose", artifacts.diagnostician)
  const fix = await g.seedCompleted("fix", "implementer", ["diagnose"], "ses_fix", artifacts.implementer)
  await g.seedCompleted("standards", "review-standards", ["fix"], standardsID, artifacts["review-standards"])
  await g.seedCompleted("spec", "review-spec", ["fix"], specID, artifacts["review-spec"])
  await g.seedCompleted("resolve", "resolver", ["standards", "spec"], "ses_fix", artifacts.resolver,
    { executionMode: { kind: "native", parentTaskKey: null, reuseFromTaskKey: "fix" } })
  return fix
}

// The sibling publication test imports the shared structural fixture, not these
// test registrations. No extra fixture/source file outside the owned scope.
if (process.argv[1]?.endsWith("derived-call-business.test.ts")) {
  test("actual shared snapshot supplies execution mode/generation and excludes objective/revision from contract digest", async t => {
    const g = await structuralDerivedFixture(); t.after(g.f.cleanup); await g.task("work"); const body = await g.body()
    const initial = await g.business.observe(body, body.task, false)
    await g.journal.append({ ...g.base(), type: "mission.updated", requestID: "req_other", expectedRevision: 2,
      notesSpecified: true, objective: "Unrelated objective", notes: "Unrelated notes" })
    await g.task("unrelated")
    assert.equal((await g.business.observe(body, body.task, false)).contractDigest, initial.contractDigest)
    assert.equal(g.business.assertCurrent(body, "reserve"), true)
    const mission = await g.mission(), task = mission.tasks.find(task => task.key === "work")!
    for (const change of [{ title: "changed" }, { brief: "changed" }, { role: "other" }, { execution: { agent: "other" } },
      { blockedBy: ["unrelated"] }, { contractGeneration: 2 }, { executionMode: { kind: "native" as const, parentTaskKey: "unrelated" } }]) {
      assert.notEqual(derivedTaskContractDigest(mission, { ...task, ...change }), body.taskContractDigest)
    }
  })
  test("effective dependency change increments own generation and invalidates the original contract without rewriting it", async t => {
    const g = await structuralDerivedFixture(); t.after(g.f.cleanup); await g.task("work"); await g.task("other"); const body = await g.body()
    await g.journal.append({ ...g.base(), type: "mission.revised", requestID: "req_dep", expectedRevision: 3,
      actorSessionID: body.coordinatorSessionID, reason: "effective task change", notesSpecified: false, retiredTasks: [], addedTasks: [],
      dependencyUpdates: [{ taskKey: "work", blockedBy: ["other"] }] })
    await assert.rejects(g.business.observe(body, body.task, false), /binding-mismatch/)
    assert.throws(() => g.business.assertCurrent(body, "reserve"), /binding-mismatch/)
  })
  test("missing genuine current-read/root/idle dependencies never qualify a business adapter", async t => {
    const g = await structuralDerivedFixture(); t.after(g.f.cleanup); await g.task("work"); const body = await g.body()
    assert.throws(() => new SharedJournalDerivedCallBusiness({ journal: g.journal, store: g.f.core.store, host: g.f.host, channel: undefined! }), /policy-unqualified/)
    g.setClaim(false)
    await assert.rejects(g.business.observe(body, body.task, false)); assert.throws(() => g.business.assertCurrent(body, "reserve"))
    assert.equal((await g.f.core.store.read()).derivedCalls, undefined)
  })
  test("absent and explicitly independent execution modes cannot be treated as signed native tasks", async t => {
    const g = await structuralDerivedFixture(); t.after(g.f.cleanup)
    for (const [key, mode] of [["legacy", undefined], ["root", { kind: "independent", reason: "existing-root", explanation: "explicit root" }]] as const) {
      await g.task(key, { executionMode: mode }); const body = await g.body(key)
      await assert.rejects(g.business.observe(body, body.task, false), /binding-mismatch/)
    }
  })
  test("independent signed task calls can both be active while a different workstream has an unmet prerequisite", async t => {
    const g = await structuralDerivedFixture(); t.after(g.f.cleanup)
    await g.task("android-build"); await g.task("ios-xcode")
    await g.task("ios-build", { blockedBy: ["ios-xcode"] })
    const android = await g.body("android-build")
    await g.start(android); await g.bind(android, "ses_android")
    const xcode = await g.body("ios-xcode")
    await g.start(xcode); await g.bind(xcode, "ses_ios")
    const map = await g.mission()
    for (const [key, actor] of [["android-build", "ses_android"], ["ios-xcode", "ses_ios"]]) {
      const task = map.tasks.find(task => task.key === key)!
      assert.equal(task.actorSessionId, actor)
      assert.ok(task.nativeExecution?.binding)
      assert.equal(task.nativeExecution?.ended, undefined, "one call does not have to return before the other binds")
      assert.equal(task.report, undefined)
    }
    const ios = await g.body("ios-build")
    assert.equal((await g.business.observe(ios, ios.task, false)).dependenciesCompleted, false)
    await assert.rejects(g.start(ios), /authorization-blocked/)
  })
  test("raw unenveloped native helper is never a declared task parent", async t => {
    const g = await structuralDerivedFixture(); t.after(g.f.cleanup); await g.task("parent"); const parent = await g.body("parent")
    await g.journal.append({ ...g.base(), type: "task.native-bound", taskKey: "parent", binding: derivedNativeBinding(parent),
      actor: { sessionID: "ses_helper", title: "Helper", location: { directory: g.f.project }, managed: false } })
    await g.task("nested", { executionMode: { kind: "native", parentTaskKey: "parent" } }); const body = await g.body("nested")
    await assert.rejects(g.business.observe(body, body.task, false), /authorization-blocked/)
  })
  test("accepted signed parent uses its OWN generation independently of its child's generation", async t => {
    const g = await structuralDerivedFixture(); t.after(g.f.cleanup)
    await g.seedCompleted("dependency", "worker", [], "ses_dep")
    await g.task("parent"); const parent = await g.body("parent"); await g.start(parent); await g.bind(parent, "ses_parent")
    await g.task("nested", { executionMode: { kind: "native", parentTaskKey: "parent" } })
    await g.journal.append({ ...g.base(), type: "mission.revised", requestID: "req_nested", expectedRevision: 8,
      actorSessionID: parent.coordinatorSessionID, reason: "own generation", notesSpecified: false, retiredTasks: [], addedTasks: [],
      dependencyUpdates: [{ taskKey: "nested", blockedBy: ["dependency"] }] })
    const body = await g.body("nested"); assert.equal(body.task.generation, 2); assert.equal(body.parentTask!.generation, 1)
    const observation = await g.business.observe(body, body.task, false); assert.deepEqual(observation.parent?.reference, parent.task)
    await g.start(body); await g.bind(body, "ses_nested")
  })
  test("explicit source report and returned current execution are separate from full-family idle observation", async t => {
    const g = await structuralDerivedFixture(); t.after(g.f.cleanup); await g.task("source"); const source = await g.body("source")
    await g.start(source); await g.bind(source); await g.report(source)
    await g.task("reuse", { blockedBy: ["source"], executionMode: { kind: "native", parentTaskKey: null, reuseFromTaskKey: "source" } })
    const body = await g.body("reuse", { choice: { kind: "reuse", sessionID: "ses_child", fromTask: source.task } })
    await assert.rejects(g.business.assertIdle("ses_child", freshSignal(), body), /binding-mismatch/); assert.equal(g.idleReads(), 0)
    await g.end(source); g.setIdle(false)
    await assert.rejects(g.business.assertIdle("ses_child", freshSignal(), body), /full family busy/)
    assert.equal(g.idleReads(), 1); g.setIdle(true)
    assert.equal(await g.business.assertIdle("ses_child", freshSignal(), body), true)
    g.setIdle(false); assert.throws(() => g.business.assertCurrent(body, "reserve"), /policy-unqualified/)
  })
  test("disconnected native context reuse still requires the exact returned source and fresh idle", async t => {
    const g = await structuralDerivedFixture(); t.after(g.f.cleanup)
    await g.task("source"); const source = await g.body("source")
    await g.start(source); await g.bind(source, "ses_source"); await g.report(source, "ses_source")
    await g.task("ios-xcode", { executionMode: { kind: "native", parentTaskKey: null, reuseFromTaskKey: "source" } })
    const body = await g.body("ios-xcode", { choice: { kind: "reuse", sessionID: "ses_source", fromTask: source.task } })
    await assert.rejects(g.business.assertIdle("ses_source", freshSignal(), body), /binding-mismatch/)
    await g.end(source, "ses_source")
    g.setIdle(false)
    await assert.rejects(g.business.assertIdle("ses_source", freshSignal(), body), /full family busy/)
    g.setIdle(true)
    assert.equal(await g.business.assertIdle("ses_source", freshSignal(), body), true)
    const wrong = await g.body("ios-xcode", { choice: { kind: "reuse", sessionID: "ses_sibling", fromTask: source.task } })
    await assert.rejects(g.business.assertIdle("ses_sibling", freshSignal(), wrong), /binding-mismatch/)
    assert.deepEqual((await g.mission()).tasks.find(task => task.key === "ios-xcode")!.blockedBy, [])
  })
  test("reuse cannot infer its source/child from reports or select a sibling native session", async t => {
    const g = await structuralDerivedFixture(); t.after(g.f.cleanup); const source = await g.seedCompleted("source", "worker", [], "ses_source")
    await g.task("reuse", { blockedBy: ["source"] })
    const body = await g.body("reuse", { choice: { kind: "reuse", sessionID: "ses_source", fromTask: source.task } })
    await assert.rejects(g.business.assertIdle("ses_source", freshSignal(), body), /binding-mismatch/)
    await g.task("selected", { blockedBy: ["source"], executionMode: { kind: "native", parentTaskKey: null, reuseFromTaskKey: "source" } })
    const sibling = await g.body("selected", { choice: { kind: "reuse", sessionID: "ses_sibling", fromTask: source.task } })
    await assert.rejects(g.business.assertIdle("ses_sibling", freshSignal(), sibling), /binding-mismatch/)
  })
  test("native child parent/project/full location and actual physical root are not inferred from the requested directory", async t => {
    const g = await structuralDerivedFixture(); t.after(g.f.cleanup); await g.task("work"); const body = await g.body(); g.native(body)
    const original = structuredClone(g.children.get("ses_child")!)
    for (const change of [{ parentSessionID: "ses_foreign" }, { projectID: "foreign-project" }]) {
      g.children.set("ses_child", { ...original, ...change }); await assert.rejects(g.business.child("ses_child", body, "bind"), /binding-mismatch/)
    }
    g.children.set("ses_child", original); g.setRoot({ mode: "git", directory: g.f.project, family: "foreign-family", checkout: "foreign-checkout" })
    await assert.rejects(g.business.child("ses_child", body, "bind"), /binding-mismatch/)
    g.setRoot(body.root); await g.start(body); await g.bind(body)
    g.children.get("ses_child")!.location.workspaceID = "changed-full-location"
    const child = await g.business.child("ses_child", body, "execute")
    await assert.rejects(g.business.accepted(body, child, "execute"), /binding-mismatch/)
  })
  test("actual provider observations are mandatory before execute, not reconstructed from profile settings", async t => {
    const g = await structuralDerivedFixture(); t.after(g.f.cleanup); await g.task("work"); const body = await g.body(); await g.start(body); await g.bind(body)
    g.setObserved(false)
    await assert.rejects(g.authority.authorize(body.reservationID, "execute", g.context(body, "execute", "ses_child"), freshSignal()))
    g.setObserved(true); g.children.get("ses_child")!.execution = { agent: "changed", model: { providerID: "changed", id: "changed" } }
    await assert.rejects(g.business.child("ses_child", body, "execute"), /binding-mismatch/)
    const report = await g.authority.authorize(body.reservationID, "report", g.context(body, "report", "ses_child"), freshSignal())
    assert.deepEqual(report.child.execution, body.execution, "original native admission observation, not the mutable current profile")
  })
  test("physical root claim loss during awaited resolution fails closed without storing any private task state", async t => {
    const g = await structuralDerivedFixture(); t.after(g.f.cleanup); await g.task("work"); const body = await g.body(); g.native(body)
    g.resolverHook(async () => { await Promise.resolve(); g.setClaim(false) })
    await assert.rejects(g.business.child("ses_child", body, "bind"))
    assert.equal((await g.journal.snapshot()).missions[0].tasks[0].nativeBinding, undefined)
  })
  test("fresh bounded journal reads reject damage and refused native events instead of trusting event presence", async t => {
    const g = await structuralDerivedFixture(); t.after(g.f.cleanup); await g.task("work"); const body = await g.body(); g.native(body)
    await g.journal.append({ ...g.base(), type: "task.native-bound", taskKey: "work", binding: { ...derivedNativeBinding(body), generation: 9 },
      actor: { sessionID: "ses_child", title: "Child", location: { directory: g.f.project }, managed: false } })
    await assert.rejects(g.business.observe(body, body.task, false), /observation-unavailable/)
    assert.throws(() => g.business.assertCurrent(body, "reserve"), /observation-unavailable/)
  })
  test("accepted event presence cannot relabel an existing task actor as a fresh new native child", async t => {
    const g = await structuralDerivedFixture(); t.after(g.f.cleanup); await g.seedCompleted("source", "worker", [], "ses_existing")
    await g.task("work"); const body = await g.body(); g.native(body, "ses_existing")
    const actor = (await g.mission()).actors.find(actor => actor.sessionId === "ses_existing")!
    await g.journal.append({ ...g.base(), type: "task.native-bound", taskKey: "work", binding: derivedNativeBinding(body),
      actor: { sessionID: actor.sessionId, title: actor.title, location: actor.location, managed: actor.managed } })
    const child = await g.business.child("ses_existing", body, "bind")
    await assert.rejects(g.business.accepted(body, child, "bind"), /binding-mismatch/)
  })
  test("Pocock admission uses completed dependency-connected applicable evidence and permits fresh native child validators", async t => {
    const g = await structuralDerivedFixture("pocock-fix-bug"); t.after(g.f.cleanup); await seedPocock(g)
    await g.task("validate", { role: "validator", blockedBy: ["resolve"] }); const body = await g.body("validate")
    g.native(body, "ses_fresh_validator")
    const child = await g.business.child("ses_fresh_validator", body, "bind")
    const actor = await g.business.prepareBinding(body, child)
    assert.equal(actor.sessionID, "ses_fresh_validator"); assert.equal(child.parentSessionID, body.coordinatorSessionID)
    assert.equal(g.business.assertCurrent(body, "reserve"), true, "freshness never means primary/root shape")
  })
  for (const [standardsID, specID] of [["ses_fix", "ses_spec"], ["ses_standards", "ses_standards"]]) {
    test(`Pocock evidence rejects reused review identities (${standardsID}, ${specID})`, async t => {
      const g = await structuralDerivedFixture("pocock-fix-bug"); t.after(g.f.cleanup); await seedPocock(g, standardsID, specID)
      await g.task("validate", { role: "validator", blockedBy: ["resolve"] }); const body = await g.body("validate")
      g.native(body, "ses_validator"); const child = await g.business.child("ses_validator", body, "bind")
      await assert.rejects(g.business.prepareBinding(body, child), /binding-mismatch/)
    })
  }
  test("Pocock reviewer/validator native child IDs must differ from implementer and each other, not just use new call IDs", async t => {
    const g = await structuralDerivedFixture("pocock-fix-bug"); t.after(g.f.cleanup); await seedPocock(g)
    await g.task("validate", { role: "validator", blockedBy: ["resolve"] }); const body = await g.body("validate")
    for (const id of ["ses_fix", "ses_standards", "ses_spec"]) {
      g.native(body, id); const child = await g.business.child(id, body, "bind")
      await assert.rejects(g.business.prepareBinding(body, child), /binding-mismatch/)
    }
  })
  test("Pocock declarations or unrelated completed roles cannot supply admission evidence", async t => {
    const g = await structuralDerivedFixture("pocock-fix-bug"); t.after(g.f.cleanup)
    await g.seedCompleted("diagnose", "diagnostician", [], "ses_diag", artifacts.diagnostician)
    await g.seedCompleted("fix", "implementer", ["diagnose"], "ses_fix", artifacts.implementer)
    await g.task("review", { role: "review-spec", blockedBy: [] }); const body = await g.body("review"); g.native(body, "ses_review")
    await assert.rejects(g.business.prepareBinding(body, await g.business.child("ses_review", body, "bind")), /dependency-connected/)
  })
  test("applicable report artifacts and exact current native call evidence are checked afresh", async t => {
    const g = await structuralDerivedFixture("pocock-fix-bug"); t.after(g.f.cleanup); const fix = await seedPocock(g)
    await g.task("validate", { role: "validator", blockedBy: ["resolve"] }); const body = await g.body("validate"); g.native(body, "ses_validator")
    const entry = [...g.values.entries()].find(([, value]) => (value as unknown as MissionEvent).type === "task.reported"
      && (value as unknown as Extract<MissionEvent, { type: "task.reported" }>).report.taskKey === "spec")!
    const original = structuredClone(entry[1]), changed = structuredClone(original) as unknown as Extract<MissionEvent, { type: "task.reported" }>
    changed.report.artifact = artifacts["review-standards"]; g.values.set(entry[0], changed as unknown as MissionJsonValue)
    await assert.rejects(g.business.prepareBinding(body, await g.business.child("ses_validator", body, "bind")), /axis/)
    g.values.set(entry[0], original)
    await g.journal.append({ ...g.base(), type: "task.native-call-started", taskKey: "fix", childSessionID: "ses_fix",
      binding: { ...derivedNativeBinding(fix), toolCallID: "call_new_fix", parentMessageID: "msg_new_fix" } })
    await assert.rejects(g.business.prepareBinding(body, await g.business.child("ses_validator", body, "bind")), /authorization-blocked/)
  })
  test("old reviews cannot validate a later dependency-connected implementation tip", async t => {
    const g = await structuralDerivedFixture("pocock-fix-bug"); t.after(g.f.cleanup)
    await g.seedCompleted("diagnose", "diagnostician", [], "ses_diag", artifacts.diagnostician)
    await g.seedCompleted("old-fix", "implementer", ["diagnose"], "ses_fix", artifacts.implementer)
    await g.seedCompleted("standards", "review-standards", ["old-fix"], "ses_standards", artifacts["review-standards"])
    await g.seedCompleted("spec", "review-spec", ["old-fix"], "ses_spec", artifacts["review-spec"])
    await g.seedCompleted("new-fix", "implementer", ["old-fix"], "ses_fix", artifacts.implementer)
    await g.seedCompleted("resolve", "resolver", ["standards", "spec", "new-fix"], "ses_fix", artifacts.resolver,
      { executionMode: { kind: "native", parentTaskKey: null, reuseFromTaskKey: "new-fix" } })
    await g.task("validate", { role: "validator", blockedBy: ["resolve"] }); const body = await g.body("validate"); g.native(body, "ses_validator")
    await assert.rejects(g.business.prepareBinding(body, await g.business.child("ses_validator", body, "bind")), /authorization-blocked/)
  })
}
