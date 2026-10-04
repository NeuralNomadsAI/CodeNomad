import { z } from "zod"
import { authorityDigest, canonicalAuthority, rejectAuthority, type AuthoritySignerSnapshot } from "./authority-protocol"
import { NativeMissionAuthorityStore, type AuthorityDocument, type AuthorityGrant } from "./authority-store"
import type { NativeMissionAuthority } from "./authority-core"
import type { ProtectedHostAuthority } from "./host-authority/store"
import { assertSynchronousAuthorityGuard } from "./authority-synchronous"
import { MISSION_MAX_ACTORS } from "./model"
import { matchesExecution } from "./execution"
import { authenticateDerivedCall, assertDerivedInvocation, verifyDerivedInvocation, derivedChildBindingSchema, derivedExecutionSchema,
  derivedTaskReferenceSchema, parseDerivedCallBody, type DerivedCallBody, type DerivedCallRecord,
  type DerivedChildBinding, type DerivedInvocationLease, type DerivedInvocationPurpose,
  type DerivedInvocationVerifier, type DerivedTaskReference } from "./derived-call-protocol"

const nativeID = z.string().min(1).max(240)
const observedBindingSchema = z.object({ childSessionID: nativeID, parentSessionID: nativeID,
  generation: z.number().int().positive().safe(), toolCallID: nativeID, parentMessageID: nativeID,
  ended: z.enum(["returned", "error"]).optional(),
}).strict()
const taskObservationSchema = z.object({
  reference: derivedTaskReferenceSchema, contractDigest: z.string().regex(/^[a-f0-9]{64}$/),
  execution: derivedExecutionSchema, current: z.boolean(), running: z.boolean(), dependenciesCompleted: z.boolean(),
  parent: z.object({ reference: derivedTaskReferenceSchema, sessionID: nativeID }).strict().nullable(),
  reuseFromTask: derivedTaskReferenceSchema.optional(),
  actors: z.array(nativeID).min(1).max(MISSION_MAX_ACTORS),
  binding: observedBindingSchema.optional(), completedReport: z.boolean(),
}).strict()
export type DerivedTaskObservation = z.infer<typeof taskObservationSchema>

/** Read the shared journal/projection, not an independent plan/current/report
 * map. historical reads supply admitted report/end evidence ONLY. accepted must
 * verify current nativeExecution for sends and the exact accepted historical
 * invocation for report/end, never using a later continuation's binding.
 * assertCurrent is a mandatory synchronous managed-writer publication fence for
 * the observed task/ancestor contract, original child/call, root admission and
 * journal agreement, NOT a UI cache. assertIdle is a fresh bounded read/refusal,
 * never a wait for an executor to become idle. Neither adapter may mutate the
 * journal under this store's shared project lock. */
export interface DerivedCallBusiness {
  observe(body: Readonly<DerivedCallBody>, reference: DerivedTaskReference, historical: boolean): Promise<DerivedTaskObservation>
  child(sessionID: string, body?: Readonly<DerivedCallBody>, purpose?: DerivedInvocationPurpose): Promise<DerivedChildBinding>
  accepted(body: Readonly<DerivedCallBody>, child: Readonly<DerivedChildBinding>, purpose?: DerivedInvocationPurpose): Promise<true>
  assertCurrent(body: Readonly<DerivedCallBody>, purpose: DerivedInvocationPurpose): true
  assertIdle(sessionID: string, signal: AbortSignal, body?: Readonly<DerivedCallBody>): Promise<true>
}
type Host = Pick<ProtectedHostAuthority, "read" | "signDerivedCall" | "assertSignerCurrent"
  | "assertHostGrant" | "assertHostGrantCurrent" | "assertDerivedEvidence">
export interface DerivedCallAuthorityDependencies {
  store: NativeMissionAuthorityStore
  native: Pick<NativeMissionAuthority, "assertAdmission">
  host: Host
  business: DerivedCallBusiness
  /** No default: missing genuine invocation proof fails closed before signing. */
  invocations?: DerivedInvocationVerifier
}
const equal = (a: unknown, b: unknown) => canonicalAuthority(a) === canonicalAuthority(b)
const detach = <T>(value: T): T => structuredClone(value)

/** Autonomous derived-call authority only. Never creates/prompts native sessions,
 * writes a task plan/report, finalizes a Mission, acquires a grant or replays work.
 * Metadata publications share the EXISTING native authority document/exclusion.
 * get/set is not CAS or cross-process exclusion; genuine writer/family proof is
 * indispensable. No executor wait is held under the project publication lock. */
export class DerivedCallAuthority {
  constructor(private readonly deps: DerivedCallAuthorityDependencies) {}

  /** Single-use reservation. Exact retry reads evidence; it never re-signs,
   * activates, releases ambiguity or dispatches the original native operation. */
  async reserve(input: unknown, proof: unknown, signal: AbortSignal): Promise<DerivedCallRecord> {
    const body = parseDerivedCallBody(input)
    signal.throwIfAborted()
    this.assertFree(await this.deps.store.read(), body)
    const invocation = await this.verify(body, "reserve", proof, signal)
    const observation = await this.observe(body, body.task, false)
    await this.assertTask(body, observation, signal)
    const { signer, grant } = await this.live(body, signal)
    this.current(body, "reserve", invocation, signal, signer, grant)
    const signed = authenticateDerivedCall(this.deps.host.signDerivedCall(body, grant, invocation), signer)
    const record: DerivedCallRecord = { signed, digest: authorityDigest(body),
      publicKey: signer.publicKey.export({ format: "der", type: "spki" }).toString("base64"), state: "reserved" }
    return this.deps.store.transaction(async doc => {
      this.assertFree(doc, body)
      // Async work is preparation, not authority for the publication following it.
      const fresh = await this.observe(body, body.task, false)
      await this.assertTask(body, fresh, signal)
      await this.live(body, signal, signer, grant)
      this.assertFree(doc, body)
      this.assertCapacity(doc, body, fresh)
      const calls = doc.derivedCalls ??= []
      calls.push(record)
      this.deps.store.assertCapacity(doc)
      return detach(record)
    }, () => this.current(body, "reserve", invocation, signal, signer, grant))
  }

  /** Fresh pre-executor fence for a published reservation. Does not rerun or
   * acknowledge the native call; captured/late Tool callbacks cannot borrow a
   * different invocation or a later root grant. Call assertCurrent immediately
   * before entering the original native executor, without an intervening await. */
  async admitNative(reservationID: string, proof: unknown, signal: AbortSignal): Promise<{ assertCurrent(): true }> {
    const record = await this.required(reservationID), body = record.signed.body
    if (record.state !== "reserved") rejectAuthority("authorization-blocked")
    const invocation = await this.verify(body, "reserve", proof, signal)
    await this.assertTask(body, await this.observe(body, body.task, false), signal)
    const { signer, grant } = await this.live(body, signal)
    authenticateDerivedCall(record.signed, signer)
    const current = (): true => { this.current(body, "reserve", invocation, signal, signer, grant); return true }
    await this.deps.store.transaction(async doc => {
      const saved = this.record(doc, reservationID)
      if (!equal(saved, record)) rejectAuthority("authorization-blocked")
      await this.assertTask(body, await this.observe(body, body.task, false), signal)
      await this.live(body, signal, signer, grant)
      saved.state = "invoking"
    }, current)
    let consumed = false
    return { assertCurrent: () => {
      if (consumed) rejectAuthority("authorization-blocked")
      current(); consumed = true; return true
    } }
  }

  /** Called after awaited actual-child progress AND accepted shared journal
   * publication. A reservation/journal tear never authorizes child execution.
   * Repeated binding is refused; callers may read the original evidence instead. */
  async bind(reservationID: string, childSessionID: string, proof: unknown, signal: AbortSignal): Promise<DerivedCallRecord> {
    const record = await this.required(reservationID)
    if (record.state !== "invoking") rejectAuthority("authorization-blocked")
    const body = record.signed.body
    const invocation = await this.verify(body, "bind", proof, signal, childSessionID)
    const child = await this.child(body, childSessionID, "bind")
    const { signer, grant } = await this.live(body, signal)
    authenticateDerivedCall(record.signed, signer)
    await this.accepted(body, child, "bind")
    await this.assertTask(body, await this.observe(body, body.task, false), signal, child)
    return this.deps.store.transaction(async doc => {
      const current = this.record(doc, reservationID)
      if (current.state !== "invoking" || !equal(current, record)) rejectAuthority("request-conflict")
      this.assertNoOtherChild(doc, body, child.sessionID)
      if (!equal(await this.child(body, child.sessionID, "bind"), child)) rejectAuthority("binding-mismatch")
      await this.accepted(body, child, "bind")
      await this.assertTask(body, await this.observe(body, body.task, false), signal, child)
      await this.live(body, signal, signer, grant)
      current.child = child; current.state = "active"
      return detach(current)
    }, () => this.current(body, "bind", invocation, signal, signer, grant, child.sessionID))
  }

  /** Fresh authorization for one actual execution context or explicit report.
   * Report authority survives send revocation, but cannot be used for a send.
   * Caller must fence the returned lease immediately before its own publication
   * or provider effect; never retain it across unguarded asynchronous work. */
  async authorize(reservationID: string, purpose: "execute" | "report", proof: unknown, signal: AbortSignal): Promise<{
    body: Readonly<DerivedCallBody>; child: Readonly<DerivedChildBinding>; late: boolean; assertCurrent(): true
  }> {
    if (purpose !== "execute" && purpose !== "report") rejectAuthority("invalid-intent")
    const record = await this.required(reservationID), body = record.signed.body
    if (!record.child || purpose === "execute" && record.state !== "active") rejectAuthority("authorization-blocked")
    const invocation = await this.verify(body, purpose, proof, signal, record.child.sessionID)
    const child = await this.child(body, record.child.sessionID, purpose)
    if (!equal(child, record.child)) rejectAuthority("binding-mismatch")
    const observation = await this.observe(body, body.task, purpose === "report")
    if (purpose === "execute") await this.assertTask(body, observation, signal, child)
    else { this.assertContract(body, observation); this.assertBound(body, observation, child) }
    await this.accepted(body, child, purpose)
    let live: Awaited<ReturnType<DerivedCallAuthority["live"]>> | undefined
    if (purpose === "execute") live = await this.live(body, signal)
    else this.deps.host.assertDerivedEvidence(record.signed)
    if (!equal(await this.required(reservationID), record)) rejectAuthority("authorization-blocked")
    const current = (): true => {
      this.current(body, purpose, invocation, signal, live?.signer, live?.grant, child.sessionID)
      if (purpose === "report") this.deps.host.assertDerivedEvidence(record.signed)
      return true
    }
    current()
    return { body: deepFreeze(detach(body)), child: deepFreeze(detach(child)), late: !observation.current, assertCurrent: current }
  }

  /** Exact observed executor termination, not report completion, recursive
   * process suspension or cancellation proof. Original identity never changes. */
  async end(reservationID: string, outcome: "returned" | "error", proof: unknown, signal: AbortSignal): Promise<DerivedCallRecord> {
    if (outcome !== "returned" && outcome !== "error") rejectAuthority("invalid-intent")
    const record = await this.required(reservationID), body = record.signed.body
    if (!record.child || record.state !== "active") rejectAuthority("authorization-blocked")
    const invocation = await this.verify(body, "end", proof, signal, record.child.sessionID, outcome)
    const child = await this.child(body, record.child.sessionID, "end")
    if (!equal(child, record.child)) rejectAuthority("binding-mismatch")
    const observation = await this.observe(body, body.task, true)
    this.assertContract(body, observation); this.assertBound(body, observation, child)
    await this.accepted(body, child, "end")
    this.deps.host.assertDerivedEvidence(record.signed)
    return this.deps.store.transaction(async doc => {
      const current = this.record(doc, reservationID)
      if (!equal(current, record)) rejectAuthority("request-conflict")
      current.state = "ended"; current.ended = outcome
      return detach(current)
    }, () => {
      this.current(body, "end", invocation, signal, undefined, undefined, record.child!.sessionID, outcome)
      this.deps.host.assertDerivedEvidence(record.signed)
    })
  }

  /** Read-only evidence; never resume/repair/replay a pending call. */
  async read(reservationID: string): Promise<DerivedCallRecord | undefined> {
    if (!/^dcall_[a-f0-9]{48}$/.test(reservationID)) rejectAuthority("invalid-intent")
    return detach((await this.deps.store.read()).derivedCalls?.find(call => call.signed.body.reservationID === reservationID))
  }

  private async required(id: string): Promise<DerivedCallRecord> {
    const record = await this.read(id)
    if (!record) rejectAuthority("authorization-blocked")
    return record
  }
  private record(doc: AuthorityDocument, id: string): DerivedCallRecord {
    const record = doc.derivedCalls?.find(item => item.signed.body.reservationID === id)
    if (!record) rejectAuthority("authorization-blocked")
    return record
  }
  private async verify(body: DerivedCallBody, purpose: DerivedInvocationPurpose, proof: unknown,
    signal: AbortSignal, childSessionID?: string, outcome?: "returned" | "error"): Promise<DerivedInvocationLease> {
    return verifyDerivedInvocation(this.deps.invocations,
      { body: deepFreeze(detach(body)), purpose, childSessionID, outcome, proof, signal })
  }
  private async observe(body: DerivedCallBody, ref: DerivedTaskReference, historical: boolean): Promise<DerivedTaskObservation> {
    let raw: unknown
    try { raw = await this.deps.business.observe(body, ref, historical) }
    catch { return rejectAuthority("observation-unavailable") }
    canonicalAuthority(raw)
    const parsed = taskObservationSchema.safeParse(raw)
    if (!parsed.success || !equal(parsed.data.reference, ref) || new Set(parsed.data.actors).size !== parsed.data.actors.length
      || !parsed.data.actors.includes(body.coordinatorSessionID)) rejectAuthority("observation-unavailable")
    return parsed.data
  }
  private assertContract(body: DerivedCallBody, task: DerivedTaskObservation): void {
    if (!equal(task.reference, body.task) || task.contractDigest !== body.taskContractDigest
      || !equal(task.execution, body.execution) || !equal(task.parent?.reference ?? null, body.parentTask)
      || (task.parent?.sessionID ?? body.coordinatorSessionID) !== body.parentSessionID) rejectAuthority("binding-mismatch")
  }
  private assertBound(body: DerivedCallBody, task: DerivedTaskObservation, child: DerivedChildBinding): void {
    const binding = task.binding
    if (!binding || binding.childSessionID !== child.sessionID || binding.parentSessionID !== body.parentSessionID
      || binding.generation !== body.task.generation || binding.toolCallID !== body.toolCallID
      || binding.parentMessageID !== body.parentMessageID || !task.actors.includes(child.sessionID)) rejectAuthority("binding-mismatch")
  }
  private async assertTask(body: DerivedCallBody, task: DerivedTaskObservation, signal: AbortSignal, bound?: DerivedChildBinding): Promise<void> {
    this.assertContract(body, task)
    if (!task.current || !task.running || !task.dependenciesCompleted) rejectAuthority("authorization-blocked")
    if (body.parentTask) {
      const parent = await this.observe(body, body.parentTask, false)
      if (!parent.current || !parent.running || !parent.binding || parent.binding.childSessionID !== body.parentSessionID
        || parent.binding.generation !== body.parentTask.generation || parent.binding.ended) rejectAuthority("binding-mismatch")
      const owner = (await this.deps.store.read()).derivedCalls?.find(call => call.state === "active"
        && call.signed.body.missionID === body.missionID && equal(call.signed.body.task, body.parentTask)
        && call.child?.sessionID === body.parentSessionID)
      if (!owner || owner.signed.body.epoch !== body.epoch || owner.signed.body.provisioningGeneration !== body.provisioningGeneration
        || !equal(owner.signed.body.root, body.root)) rejectAuthority("authorization-blocked")
      this.deps.host.assertDerivedEvidence(owner.signed)
      this.assertContract(owner.signed.body, parent)
      this.assertBound(owner.signed.body, parent, owner.child!)
      if (!equal(await this.child(owner.signed.body, body.parentSessionID, "execute"), owner.child)) rejectAuthority("binding-mismatch")
      await this.accepted(owner.signed.body, owner.child!, "execute")
    }
    if (bound) {
      this.assertBound(body, task, bound)
      if (task.binding!.ended) rejectAuthority("authorization-blocked")
      return
    }
    if (body.choice.kind === "new") {
      if (task.binding || task.reuseFromTask) rejectAuthority("binding-mismatch")
      return
    }
    if (body.choice.kind === "continue") {
      if (!task.binding || task.binding.childSessionID !== body.choice.sessionID || !task.binding.ended
        || task.binding.parentSessionID !== body.parentSessionID || task.binding.generation !== body.task.generation) rejectAuthority("binding-mismatch")
    } else {
      if (!task.reuseFromTask || !equal(task.reuseFromTask, body.choice.fromTask) || task.binding) rejectAuthority("binding-mismatch")
      const previous = await this.observe(body, body.choice.fromTask, true)
      if (!previous.completedReport || previous.binding?.ended !== "returned"
        || previous.binding.childSessionID !== body.choice.sessionID || previous.binding.parentSessionID !== body.parentSessionID
        || previous.binding.generation !== body.choice.fromTask.generation) rejectAuthority("binding-mismatch")
    }
    const selectedSessionID = body.choice.sessionID
    const prior = (await this.deps.store.read()).derivedCalls?.filter(call => call.child?.sessionID === selectedSessionID).at(-1)
    const source = body.choice.kind === "continue" ? body.task : body.choice.fromTask
    if (!prior || prior.state !== "ended" || prior.signed.body.missionID !== body.missionID
      || !equal(prior.signed.body.task, source) || prior.signed.body.parentSessionID !== body.parentSessionID
      || body.choice.kind === "reuse" && prior.ended !== "returned") rejectAuthority("binding-mismatch")
    this.deps.host.assertDerivedEvidence(prior.signed)
    let idle: unknown
    try { idle = await this.deps.business.assertIdle(body.choice.sessionID, signal, body) }
    catch { return rejectAuthority("authorization-blocked") }
    if (idle !== true) rejectAuthority("authorization-blocked")
  }
  private async live(body: DerivedCallBody, signal: AbortSignal, pinned?: AuthoritySignerSnapshot, expected?: AuthorityGrant) {
    signal.throwIfAborted()
    const state = await this.deps.host.read()
    if (!state?.signer || !state.mirror || state.state !== "qualified") rejectAuthority("authorization-blocked")
    const signer = state.signer
    if (signer.provisioningGeneration !== body.provisioningGeneration || signer.signerDigest !== body.signerDigest
      || pinned && (pinned.provisioningGeneration !== signer.provisioningGeneration || pinned.signerDigest !== signer.signerDigest)) rejectAuthority("untrusted-signer")
    const grant = await this.deps.native.assertAdmission({ ...body, root: body.root })
    if (expected && !equal(grant, expected)) rejectAuthority("epoch-conflict")
    await this.deps.host.assertHostGrant(grant)
    signal.throwIfAborted()
    assertSynchronousAuthorityGuard(() => this.deps.host.assertSignerCurrent(signer), "untrusted-signer")
    assertSynchronousAuthorityGuard(() => this.deps.host.assertHostGrantCurrent(grant), "policy-unqualified")
    return { signer, grant }
  }
  private current(body: DerivedCallBody, purpose: DerivedInvocationPurpose, invocation: DerivedInvocationLease, signal: AbortSignal,
    signer?: AuthoritySignerSnapshot, grant?: AuthorityGrant, childSessionID?: string, outcome?: "returned" | "error"): void {
    signal.throwIfAborted()
    assertDerivedInvocation(invocation, body, purpose, childSessionID, outcome)
    assertSynchronousAuthorityGuard(() => this.deps.business.assertCurrent(body, purpose), "policy-unqualified")
    if (signer) assertSynchronousAuthorityGuard(() => this.deps.host.assertSignerCurrent(signer), "untrusted-signer")
    if (grant) assertSynchronousAuthorityGuard(() => this.deps.host.assertHostGrantCurrent(grant), "policy-unqualified")
  }
  private async child(body: DerivedCallBody, id: string, purpose: DerivedInvocationPurpose): Promise<DerivedChildBinding> {
    let raw: unknown
    try { raw = await this.deps.business.child(id, body, purpose) }
    catch { return rejectAuthority("observation-unavailable") }
    canonicalAuthority(raw)
    const parsed = derivedChildBindingSchema.safeParse(raw)
    if (!parsed.success || parsed.data.sessionID !== id || parsed.data.parentSessionID !== body.parentSessionID
      || id === body.parentSessionID || !equal(parsed.data.root, body.root)
      || body.choice.kind !== "new" && body.choice.sessionID !== id
      || !matchesExecution(body.execution, parsed.data.execution)) rejectAuthority("binding-mismatch")
    return parsed.data
  }
  private async accepted(body: DerivedCallBody, child: DerivedChildBinding, purpose: DerivedInvocationPurpose): Promise<void> {
    let result: unknown
    try { result = await this.deps.business.accepted(body, child, purpose) }
    catch { return rejectAuthority("observation-unavailable") }
    if (result !== true) rejectAuthority("authorization-blocked")
  }
  private assertFree(doc: AuthorityDocument, body: DerivedCallBody): void {
    for (const call of doc.derivedCalls ?? []) {
      const previous = call.signed.body
      if (previous.reservationID === body.reservationID) rejectAuthority("request-conflict")
      if (previous.parentSessionID === body.parentSessionID && (previous.toolCallID === body.toolCallID
        || previous.missionID === body.missionID && previous.task.taskKey === body.task.taskKey
          && previous.parentMessageID === body.parentMessageID)) rejectAuthority("request-conflict")
      if (call.state !== "ended" && previous.missionID === body.missionID && previous.task.taskKey === body.task.taskKey) rejectAuthority("authorization-blocked")
    }
    if (body.choice.kind !== "new") this.assertNoOtherChild(doc, body, body.choice.sessionID)
  }
  private assertNoOtherChild(doc: AuthorityDocument, body: DerivedCallBody, childID: string): void {
    if ((doc.derivedCalls ?? []).some(call => call.signed.body.reservationID !== body.reservationID && call.state !== "ended"
      && (call.child?.sessionID === childID || call.signed.body.choice.kind !== "new" && call.signed.body.choice.sessionID === childID))) rejectAuthority("authorization-blocked")
  }
  private assertCapacity(doc: AuthorityDocument, body: DerivedCallBody, task: DerivedTaskObservation): void {
    if (body.choice.kind !== "new") {
      if (!task.actors.includes(body.choice.sessionID)) rejectAuthority("binding-mismatch")
      return
    }
    const pending = (doc.derivedCalls ?? []).filter(call => (call.state === "reserved" || call.state === "invoking")
      && call.signed.body.missionID === body.missionID && call.signed.body.choice.kind === "new").length
    if (task.actors.length + pending >= MISSION_MAX_ACTORS) rejectAuthority("capacity")
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value) }
  return value
}
