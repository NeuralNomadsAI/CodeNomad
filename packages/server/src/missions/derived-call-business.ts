import { z } from "zod"
import { MissionJournal, parseMissionEvent } from "./journal"
import { MISSION_MAX_EVENTS, reduceMissionEvents, type MissionActor, type MissionEvent, type MissionMap,
  type MissionNativeBinding, type MissionTask } from "./model"
import { authorityDigest, authorityRootSchema, canonicalAuthority, rejectAuthority, type AuthorityRoot } from "./authority-protocol"
import { NativeMissionAuthorityStore, type AuthorityDocument } from "./authority-store"
import type { ProtectedHostAuthority } from "./host-authority/store"
import { assertSynchronousAuthorityGuard } from "./authority-synchronous"
import { validateMissionDelegationPolicy, validateMissionReportArtifact } from "./contracts"
import { matchesExecution } from "./execution"
import { sameNativeCall } from "./native-report-provenance"
import { derivedChildBindingSchema, derivedExecutionSchema, type DerivedCallBody, type DerivedChildBinding,
  type DerivedInvocationPurpose, type DerivedTaskReference } from "./derived-call-protocol"
import type { DerivedCallBusiness, DerivedTaskObservation } from "./derived-call-authority"

const nativeChildSchema = z.object({ sessionID: z.string().min(1).max(240), parentSessionID: z.string().min(1).max(240),
  projectID: z.string().min(1).max(240), title: z.string().min(1).max(240),
  location: z.object({ directory: z.string().min(1).max(4096), workspaceID: z.string().min(1).max(240).optional() }).strict(),
  execution: derivedExecutionSchema, executionObserved: z.boolean(),
}).strict()
export type DerivedNativeChildObservation = z.infer<typeof nativeChildSchema>
export interface DerivedJournalRead { events: readonly MissionEvent[]; discardedEvents: number }
export interface DerivedBusinessReadRequest { body: Readonly<DerivedCallBody>; purpose: DerivedInvocationPurpose }
export interface DerivedBusinessRootRequest extends DerivedBusinessReadRequest { child: DerivedNativeChildObservation }
/** Genuine held managed-writer/physical-family channel dependency. Synchronous
 * reads MUST read this exact journal/authority storage under its real claim (or
 * fail closed), not cached UI snapshots. Existing MissionJournal has async get/
 * scan only: this module does NOT invent a synchronous storage/native producer.
 * Historical provider observations belong to the original accepted invocation;
 * never reconstruct them from mutable profile/session settings. */
export interface DerivedBusinessChannel {
  assertCurrent(input: DerivedBusinessReadRequest): true
  readCurrentJournal(journal: MissionJournal, input: DerivedBusinessReadRequest): DerivedJournalRead
  readCurrentAuthority(store: NativeMissionAuthorityStore, input: DerivedBusinessReadRequest): AuthorityDocument
  readChild(sessionID: string, input: DerivedBusinessReadRequest): Promise<DerivedNativeChildObservation>
  readChildCurrent(sessionID: string, input: DerivedBusinessReadRequest): DerivedNativeChildObservation
  resolveRoot(input: DerivedBusinessRootRequest): Promise<{ root: AuthorityRoot; assertCurrent(): true }>
  resolveRootCurrent(input: DerivedBusinessRootRequest): AuthorityRoot
  assertNativeIdle(input: DerivedBusinessReadRequest & { sessionID: string; signal: AbortSignal }): Promise<true>
  assertNativeIdleCurrent(input: DerivedBusinessReadRequest & { sessionID: string }): true
}
export interface DerivedCallBusinessDependencies {
  journal: MissionJournal
  store: NativeMissionAuthorityStore
  host: Pick<ProtectedHostAuthority, "assertDerivedEvidence">
  channel: DerivedBusinessChannel
}
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const equal = (a: unknown, b: unknown) => canonicalAuthority(a) === canonicalAuthority(b)
export function derivedNativeBinding(body: Readonly<DerivedCallBody>): MissionNativeBinding {
  return { generation: body.task.generation, parentSessionID: body.parentSessionID,
    toolCallID: body.toolCallID, parentMessageID: body.parentMessageID }
}
/** Only effective own-contract fields, not mutable objective/notes/revision. */
export function derivedTaskContractDigest(mission: MissionMap, task: MissionTask): string {
  return authorityDigest(json({ missionID: mission.id, projectID: mission.projectID, projectCanonical: mission.projectCanonical,
    template: mission.template, task: { id: task.id, key: task.key, generation: task.contractGeneration,
      title: task.title, brief: task.brief, role: task.role, execution: task.execution ?? {},
      executionMode: task.executionMode, blockedBy: [...task.blockedBy].sort() } }))
}
type View = { mission: MissionMap; events: MissionEvent[] }

/** Adapter over the existing bounded journal/reducer. No plan, actor, report or
 * authority cache; sync final fences independently read the genuine held claim. */
export class SharedJournalDerivedCallBusiness implements DerivedCallBusiness {
  readonly journal: MissionJournal
  constructor(private readonly deps: DerivedCallBusinessDependencies) {
    this.journal = deps.journal
    if (!deps.channel || this.journal.projectToken !== deps.store.projectToken) rejectAuthority("policy-unqualified")
  }
  async observe(body: Readonly<DerivedCallBody>, reference: DerivedTaskReference, historical: boolean): Promise<DerivedTaskObservation> {
    const purpose = historical ? "report" : "reserve"
    this.fence(body, purpose)
    const view = this.project(await this.journal.events(), body)
    const doc = await this.deps.store.read()
    const result = this.observation(view, doc, body, reference, historical)
    this.fence(body, purpose)
    return result
  }
  async child(sessionID: string, body?: Readonly<DerivedCallBody>, purpose: DerivedInvocationPurpose = "bind"): Promise<DerivedChildBinding> {
    if (!body) rejectAuthority("policy-unqualified")
    this.fence(body, purpose)
    const child = this.native(await this.deps.channel.readChild(sessionID, { body, purpose }), sessionID, body, purpose)
    const resolved = await this.deps.channel.resolveRoot({ body, purpose, child })
    assertSynchronousAuthorityGuard(() => resolved.assertCurrent(), "policy-unqualified")
    this.fence(body, purpose)
    return this.childBinding(body, child, resolved.root)
  }
  async accepted(body: Readonly<DerivedCallBody>, child: Readonly<DerivedChildBinding>, purpose: DerivedInvocationPurpose = "bind"): Promise<true> {
    this.fence(body, purpose)
    const view = this.project(await this.journal.events(), body)
    this.acceptedIn(view, body, child, purpose)
    this.fence(body, purpose)
    return true
  }
  assertCurrent(body: Readonly<DerivedCallBody>, purpose: DerivedInvocationPurpose): true {
    this.fence(body, purpose)
    const view = this.project(this.deps.channel.readCurrentJournal(this.journal, { body, purpose }), body)
    const doc = this.deps.channel.readCurrentAuthority(this.deps.store, { body, purpose })
    const observation = this.observation(view, doc, body, body.task, purpose === "report" || purpose === "end")
    if (observation.contractDigest !== body.taskContractDigest || !equal(observation.parent?.reference ?? null, body.parentTask)
      || (observation.parent?.sessionID ?? body.coordinatorSessionID) !== body.parentSessionID) rejectAuthority("binding-mismatch")
    if (purpose !== "report" && purpose !== "end") {
      if (!observation.current || !observation.running || !observation.dependenciesCompleted) rejectAuthority("authorization-blocked")
      this.policy(view.mission, this.task(view, body.task), body)
    }
    if (purpose === "reserve") {
      this.choice(view, body)
      if (body.choice.kind !== "new") {
        const sessionID = body.choice.sessionID
        const child = this.native(this.deps.channel.readChildCurrent(sessionID, { body, purpose }), sessionID, body, purpose)
        this.childBinding(body, child, this.deps.channel.resolveRootCurrent({ body, purpose, child }))
        assertSynchronousAuthorityGuard(() => this.deps.channel.assertNativeIdleCurrent({ body, purpose, sessionID }), "policy-unqualified")
      }
    } else {
      const id = this.task(view, body.task).actorSessionId
      if (!id) rejectAuthority("binding-mismatch")
      const native = this.native(this.deps.channel.readChildCurrent(id, { body, purpose }), id, body, purpose)
      const root = this.deps.channel.resolveRootCurrent({ body, purpose, child: native })
      this.acceptedIn(view, body, this.childBinding(body, native, root), purpose)
    }
    this.fence(body, purpose)
    return true
  }
  async assertIdle(sessionID: string, signal: AbortSignal, body?: Readonly<DerivedCallBody>): Promise<true> {
    if (!body || body.choice.kind === "new" || body.choice.sessionID !== sessionID) rejectAuthority("binding-mismatch")
    signal.throwIfAborted(); this.fence(body, "reserve")
    this.choice(this.project(await this.journal.events(), body), body)
    await this.child(sessionID, body, "reserve")
    const result: unknown = await this.deps.channel.assertNativeIdle({ body, purpose: "reserve", sessionID, signal })
    if (result !== true) rejectAuthority("policy-unqualified")
    signal.throwIfAborted(); this.fence(body, "reserve")
    return true
  }
  /** Publication preparation only: caller must still authenticate the original
   * native invocation and hold the actual guarded-write claim. */
  async prepareBinding(body: Readonly<DerivedCallBody>, child: DerivedChildBinding): Promise<{
    sessionID: string; title: string; location: MissionActor["location"]; managed: boolean
  }> {
    const view = this.project(await this.journal.events(), body)
    const observation = this.observation(view, await this.deps.store.read(), body, body.task, false)
    if (observation.contractDigest !== body.taskContractDigest || !observation.current || !observation.running
      || !observation.dependenciesCompleted) rejectAuthority("authorization-blocked")
    this.choice(view, body); this.policy(view.mission, this.task(view, body.task), body, child.sessionID)
    if (body.choice.kind === "new" && view.mission.actors.some(actor => actor.sessionId === child.sessionID)) rejectAuthority("binding-mismatch")
    const actor = view.mission.actors.find(actor => actor.sessionId === child.sessionID)
    if (!child.location) rejectAuthority("binding-mismatch")
    return { sessionID: child.sessionID, title: actor?.title ?? this.task(view, body.task).title,
      location: structuredClone(actor?.location ?? child.location), managed: actor?.managed ?? false }
  }
  assertBindingPublicationCurrent(body: Readonly<DerivedCallBody>, child: DerivedChildBinding): true {
    // The original native executor has already entered. Admission required a
    // fresh full-family idle read; binding must not mistake THIS invocation's
    // own activity for a foreign busy actor or wait for it to become idle again.
    this.fence(body, "bind")
    const view = this.project(this.deps.channel.readCurrentJournal(this.journal, { body, purpose: "bind" }), body)
    const doc = this.deps.channel.readCurrentAuthority(this.deps.store, { body, purpose: "bind" })
    const observed = this.observation(view, doc, body, body.task, false)
    if (observed.contractDigest !== body.taskContractDigest || !observed.current || !observed.running || !observed.dependenciesCompleted
      || !equal(observed.parent?.reference ?? null, body.parentTask)
      || (observed.parent?.sessionID ?? body.coordinatorSessionID) !== body.parentSessionID) rejectAuthority("binding-mismatch")
    this.choice(view, body)
    this.policy(view.mission, this.task(view, body.task), body, child.sessionID)
    if (body.choice.kind === "new" && view.mission.actors.some(actor => actor.sessionId === child.sessionID)) rejectAuthority("binding-mismatch")
    const native = this.native(this.deps.channel.readChildCurrent(child.sessionID, { body, purpose: "bind" }), child.sessionID, body, "bind")
    const actual = this.childBinding(body, native, this.deps.channel.resolveRootCurrent({ body, purpose: "bind", child: native }))
    if (!equal(actual, child)) rejectAuthority("binding-mismatch")
    this.fence(body, "bind")
    return true
  }
  assertEndPublicationCurrent(body: Readonly<DerivedCallBody>, child: DerivedChildBinding): true {
    this.assertCurrent(body, "end")
    const view = this.project(this.deps.channel.readCurrentJournal(this.journal, { body, purpose: "end" }), body)
    const task = this.task(view, body.task)
    if (!sameNativeCall(task.nativeExecution?.binding, derivedNativeBinding(body)) || task.nativeExecution?.ended
      || task.actorSessionId !== child.sessionID) rejectAuthority("authorization-blocked")
    return true
  }
  async ended(body: Readonly<DerivedCallBody>, child: DerivedChildBinding, outcome: "returned" | "error"): Promise<true> {
    const view = this.project(await this.journal.events(), body), task = this.task(view, body.task)
    if (task.actorSessionId !== child.sessionID || !sameNativeCall(task.nativeExecution?.binding, derivedNativeBinding(body))
      || task.nativeExecution?.ended !== outcome) rejectAuthority("binding-mismatch")
    return true
  }
  async originalActor(body: Readonly<DerivedCallBody>, childSessionID: string): Promise<MissionActor> {
    const view = this.project(await this.journal.events(), body)
    const actor = view.mission.actors.find(actor => actor.sessionId === childSessionID)
    if (!actor) rejectAuthority("binding-mismatch")
    return structuredClone(actor)
  }
  async endEventType(body: Readonly<DerivedCallBody>, outcome: "returned" | "error"): Promise<"task.native-returned" | "task.native-call-ended"> {
    const view = this.project(await this.journal.events(), body)
    return outcome === "returned" && sameNativeCall(this.task(view, body.task).nativeBinding, derivedNativeBinding(body))
      ? "task.native-returned" : "task.native-call-ended"
  }
  async nextEventTime(body: Readonly<DerivedCallBody>): Promise<number> {
    const view = this.project(await this.journal.events(), body)
    const next = Math.max(Date.now(), (view.events.at(-1)?.createdAt ?? 0) + 1)
    if (!Number.isSafeInteger(next)) rejectAuthority("capacity")
    return next
  }
  private fence(body: Readonly<DerivedCallBody>, purpose: DerivedInvocationPurpose): void {
    assertSynchronousAuthorityGuard(() => this.deps.channel.assertCurrent({ body, purpose }), "policy-unqualified")
  }
  private project(read: DerivedJournalRead, body: Readonly<DerivedCallBody>): View {
    if (read.discardedEvents || !Array.isArray(read.events) || read.events.length > MISSION_MAX_EVENTS) rejectAuthority("observation-unavailable")
    const events = read.events.map(event => parseMissionEvent(event))
    if (events.some(event => !event)) rejectAuthority("observation-unavailable")
    const valid = events as MissionEvent[]
    if (new Set(valid.map(event => `${event.missionID}/${event.id}`)).size !== valid.length) rejectAuthority("observation-unavailable")
    const snapshot = reduceMissionEvents(valid, 1)
    const mission = snapshot.missions.find(mission => mission.id === body.missionID)
    if (snapshot.discardedEvents || snapshot.controlUnavailable || snapshot.notificationUnavailable || !mission
      || mission.projectID !== body.projectID || mission.projectCanonical !== body.projectCanonical
      || mission.coordinatorSessionId !== body.coordinatorSessionID) rejectAuthority("observation-unavailable")
    return { mission, events: valid.filter(event => event.missionID === body.missionID).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)) }
  }
  private task(view: View, ref: DerivedTaskReference): MissionTask {
    const task = view.mission.tasks.find(task => task.key === ref.taskKey)
    if (!task || task.contractGeneration !== ref.generation) rejectAuthority("binding-mismatch")
    return task
  }
  private observation(view: View, doc: AuthorityDocument, body: Readonly<DerivedCallBody>, ref: DerivedTaskReference, historical: boolean): DerivedTaskObservation {
    const task = this.task(view, ref), mode = task.executionMode
    if (mode?.kind !== "native") rejectAuthority("binding-mismatch")
    const own = equal(ref, body.task)
    const parentTask = mode.parentTaskKey === null ? undefined : view.mission.tasks.find(task => task.key === mode.parentTaskKey)
    if (mode.parentTaskKey !== null && (!parentTask || !parentTask.contractGeneration || !parentTask.actorSessionId)) rejectAuthority("binding-mismatch")
    const parent = parentTask ? { reference: { taskKey: parentTask.key, generation: parentTask.contractGeneration! }, sessionID: parentTask.actorSessionId! } : null
    if (parent && !historical) this.parent(view, doc, body, parent.reference, parent.sessionID)
    const call = own && historical ? this.historicalCall(view, body) : task.nativeExecution
    const binding = call && task.actorSessionId ? { childSessionID: task.actorSessionId, ...call.binding,
      ...(call.ended ? { ended: call.ended } : {}) } : undefined
    const current = task.status !== "withdrawn" && !task.replacedByTaskKey
      && (!historical || !own || !task.nativeExecution || sameNativeCall(task.nativeExecution.binding, derivedNativeBinding(body)))
    return { reference: { ...ref }, contractDigest: derivedTaskContractDigest(view.mission, task), execution: json(task.execution ?? {}),
      current, running: view.mission.status === "active" && view.mission.runState === "running" && !view.mission.control?.pending.length,
      dependenciesCompleted: task.blockedBy.every(key => this.complete(view.mission.tasks.find(task => task.key === key))), parent,
      ...(mode.reuseFromTaskKey ? { reuseFromTask: this.reference(view, mode.reuseFromTaskKey) } : {}),
      actors: view.mission.actors.map(actor => actor.sessionId), ...(binding ? { binding } : {}), completedReport: this.complete(task) }
  }
  private reference(view: View, key: string): DerivedTaskReference {
    const task = view.mission.tasks.find(task => task.key === key)
    if (!task?.contractGeneration) rejectAuthority("binding-mismatch")
    return { taskKey: key, generation: task.contractGeneration }
  }
  private parent(view: View, doc: AuthorityDocument, body: Readonly<DerivedCallBody>, ref: DerivedTaskReference, sessionID: string): void {
    const task = this.task(view, ref)
    const owner = doc.derivedCalls?.find(call => call.state === "active" && call.child?.sessionID === sessionID
      && call.signed.body.missionID === body.missionID && equal(call.signed.body.task, ref)
      && sameNativeCall(task.nativeExecution?.binding, derivedNativeBinding(call.signed.body)))
    if (!owner || !owner.child || task.status === "withdrawn" || task.nativeExecution?.ended
      || owner.signed.body.epoch !== body.epoch || owner.signed.body.provisioningGeneration !== body.provisioningGeneration
      || !equal(owner.signed.body.root, body.root)) rejectAuthority("authorization-blocked")
    assertSynchronousAuthorityGuard(() => this.deps.host.assertDerivedEvidence(owner.signed), "untrusted-signer")
    this.acceptedIn(view, owner.signed.body, owner.child, "execute")
  }
  private historicalCall(view: View, body: Readonly<DerivedCallBody>): { binding: MissionNativeBinding; ended?: "returned" | "error" } | undefined {
    const expected = derivedNativeBinding(body)
    const indices = view.events.flatMap((event, index) => (event.type === "task.native-bound" || event.type === "task.native-call-started")
      && event.taskKey === body.task.taskKey && sameNativeCall(event.binding, expected) ? [index] : [])
    if (!indices.length) return undefined
    if (indices.length !== 1) rejectAuthority("request-conflict")
    const at = (index: number) => reduceMissionEvents(view.events.slice(0, index + 1), 1).missions[0]?.tasks.find(task => task.key === body.task.taskKey)
    const accepted = at(indices[0])
    const task = this.task(view, body.task)
    if (!accepted?.nativeExecution || !sameNativeCall(accepted.nativeExecution.binding, expected)
      || accepted.actorSessionId !== task.actorSessionId) rejectAuthority("binding-mismatch")
    if (body.choice.kind === "new" && reduceMissionEvents(view.events.slice(0, indices[0]), 1).missions[0]?.actors
      .some(actor => actor.sessionId === accepted.actorSessionId)) rejectAuthority("binding-mismatch")
    let ended: "returned" | "error" | undefined
    for (let i = indices[0] + 1; i < view.events.length; i++) {
      const event = view.events[i]
      if ((event.type === "task.native-returned" || event.type === "task.native-call-ended")
        && event.taskKey === body.task.taskKey && sameNativeCall(event.binding, expected)
        && event.childSessionID === task.actorSessionId) {
        const execution = at(i)?.nativeExecution
        if (!sameNativeCall(execution?.binding, expected) || !execution?.ended) rejectAuthority("binding-mismatch")
        ended = execution.ended
      }
    }
    return { binding: expected, ...(ended ? { ended } : {}) }
  }
  private acceptedIn(view: View, body: Readonly<DerivedCallBody>, child: Readonly<DerivedChildBinding>, purpose: DerivedInvocationPurpose): void {
    const task = this.task(view, body.task), actor = view.mission.actors.find(actor => actor.sessionId === child.sessionID)
    const history = this.historicalCall(view, body)
    if (derivedTaskContractDigest(view.mission, task) !== body.taskContractDigest
      || !history || !actor || task.actorSessionId !== child.sessionID || child.projectID !== body.projectID
      || !child.location || !equal(json(actor.location), child.location) || !equal(child.root, body.root)) rejectAuthority("binding-mismatch")
    if (purpose !== "report" && purpose !== "end") {
      if (!sameNativeCall(task.nativeExecution?.binding, history.binding) || task.nativeExecution?.ended || task.status === "withdrawn") rejectAuthority("authorization-blocked")
      this.policy(view.mission, task, body, child.sessionID)
    }
  }
  private native(raw: DerivedNativeChildObservation, id: string, body: Readonly<DerivedCallBody>, purpose: DerivedInvocationPurpose): DerivedNativeChildObservation {
    canonicalAuthority(raw)
    const parsed = nativeChildSchema.safeParse(raw)
    if (!parsed.success || parsed.data.sessionID !== id || parsed.data.parentSessionID !== body.parentSessionID
      || parsed.data.projectID !== body.projectID || id === body.parentSessionID
      || !matchesExecution(body.execution, parsed.data.execution)
      || purpose === "execute" && (!parsed.data.executionObserved || !parsed.data.execution.agent || !parsed.data.execution.model)) rejectAuthority("binding-mismatch")
    return parsed.data
  }
  private childBinding(body: Readonly<DerivedCallBody>, child: DerivedNativeChildObservation, rawRoot: AuthorityRoot): DerivedChildBinding {
    const root = authorityRootSchema.parse(rawRoot)
    if (!equal(root, body.root) || body.choice.kind !== "new" && child.sessionID !== body.choice.sessionID) rejectAuthority("binding-mismatch")
    return derivedChildBindingSchema.parse({ sessionID: child.sessionID, parentSessionID: child.parentSessionID,
      projectID: child.projectID, location: child.location, execution: child.execution, root })
  }
  private complete(task?: MissionTask): boolean {
    return Boolean(task && task.status === "completed" && !task.replacedByTaskKey && task.report?.outcome === "completed"
      && task.report.taskKey === task.key && task.report.sessionId === task.actorSessionId
      && (task.executionMode?.kind !== "native" || task.report.nativeCall?.generation === task.contractGeneration
        && sameNativeCall(task.report.nativeCall, task.nativeExecution?.binding)))
  }
  private choice(view: View, body: Readonly<DerivedCallBody>): void {
    const task = this.task(view, body.task), mode = task.executionMode
    if (mode?.kind !== "native" || derivedTaskContractDigest(view.mission, task) !== body.taskContractDigest) rejectAuthority("binding-mismatch")
    if (body.choice.kind === "new") {
      if (mode.reuseFromTaskKey || task.actorSessionId || task.nativeBinding) rejectAuthority("binding-mismatch")
    } else if (body.choice.kind === "continue") {
      if (task.actorSessionId !== body.choice.sessionID || !task.nativeExecution?.ended
        || task.nativeExecution.binding.generation !== body.task.generation) rejectAuthority("binding-mismatch")
    } else {
      const source = this.task(view, body.choice.fromTask)
      if (mode.reuseFromTaskKey !== source.key || task.actorSessionId || !this.complete(source)
        || source.actorSessionId !== body.choice.sessionID || source.nativeExecution?.ended !== "returned"
        || source.nativeExecution.binding.parentSessionID !== body.parentSessionID) rejectAuthority("binding-mismatch")
    }
    this.policy(view.mission, task, body)
  }
  private policy(mission: MissionMap, task: MissionTask, body: Readonly<DerivedCallBody>, childID?: string): void {
    validateMissionDelegationPolicy({ template: mission.template, role: task.role, blockedBy: task.blockedBy,
      executionMode: task.executionMode, phase: "admission", tasks: mission.tasks,
      ...(body.choice.kind === "reuse" ? { targetSessionID: body.choice.sessionID } : {}) })
    const connected = new Set<string>()
    const visit = (key: string) => { if (connected.has(key)) return; connected.add(key)
      const dependency = mission.tasks.find(task => task.key === key)
      if (!dependency) rejectAuthority("binding-mismatch")
      dependency.blockedBy.forEach(visit) }
    task.blockedBy.forEach(visit)
    const evidence = mission.tasks.filter(task => connected.has(task.key))
    if (evidence.some(task => !this.complete(task))) rejectAuthority("authorization-blocked")
    for (const task of evidence) {
      validateMissionReportArtifact({ template: mission.template, role: task.role, outcome: "completed", artifact: task.report?.artifact })
      validateMissionDelegationPolicy({ template: mission.template, role: task.role, blockedBy: task.blockedBy,
        executionMode: task.executionMode, phase: "admission", tasks: mission.tasks,
        ...(task.role === "resolver" ? { targetSessionID: task.actorSessionId } : {}) })
    }
    if (mission.template !== "pocock-fix-bug") return
    const axes = ["review-standards", "review-spec", "validator"]
    const distinct = evidence.filter(task => axes.includes(task.role) || task.role === "implementer")
    const reviews = distinct.filter(task => axes.includes(task.role))
    if (reviews.some(task => !task.actorSessionId || distinct.some(other => other.key !== task.key && other.actorSessionId === task.actorSessionId))) rejectAuthority("binding-mismatch")
    if (axes.includes(task.role) && childID && mission.tasks.some(other => other.key !== task.key
      && other.actorSessionId === childID && (axes.includes(other.role) || other.role === "implementer"))) rejectAuthority("binding-mismatch")
    const implementations = evidence.filter(task => task.role === "implementer" && !task.replacedByTaskKey)
    const tips = implementations.filter(task => !implementations.some(other => other.key !== task.key && reaches(mission.tasks, other.blockedBy, task.key)))
    if ((axes.includes(task.role) || task.role === "resolver") && (tips.length !== 1
      || reviews.some(review => !reaches(mission.tasks, review.blockedBy, tips[0].key)))) rejectAuthority("authorization-blocked")
  }
}
function reaches(tasks: readonly MissionTask[], keys: readonly string[], target: string, seen = new Set<string>()): boolean {
  return keys.some(key => { if (key === target) return true; if (seen.has(key)) return false; seen.add(key)
    return reaches(tasks, tasks.find(task => task.key === key)?.blockedBy ?? [], target, seen) })
}
