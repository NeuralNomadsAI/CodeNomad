import { Model } from "@opencode/schema/model"
import { z } from "zod"
import { NATIVE_MISSIONS_PROTOCOL, NATIVE_MISSIONS_AUTHORITY_PROTOCOL, MISSIONS_CHANNEL_METHODS,
  MISSIONS_AUTHORITY_METHODS } from "../../host-lifetime/native-missions-contract"
import { authorityDigest, canonicalAuthority, rejectAuthority } from "../../missions/authority-protocol"
import { DerivedCallAuthority, type DerivedCallAuthorityDependencies } from "../../missions/derived-call-authority"
import { SharedJournalDerivedCallBusiness, derivedNativeBinding, derivedTaskContractDigest, type DerivedCallBusinessDependencies } from "../../missions/derived-call-business"
import { matchesExecution } from "../../missions/execution"
import { sameNativeCall } from "../../missions/native-report-provenance"
import { DerivedCallPublication } from "../../missions/derived-call-publication"
import { DERIVED_CALL_POLICY, derivedReservationID, derivedExecutionSchema, parseDerivedCallBody,
  type DerivedCallBody } from "../../missions/derived-call-protocol"
import { createMissionNativePreparation, type PreparedMissionNativeExecution } from "../../server/routes/mission-native-preparation"
import type { MissionNativeReportAuthorization } from "../../missions/control-types"
import type { NativeTaskAdmissions, NativeTaskInvocation, NativeTaskFence } from "./native-task-adapter"
import type { NativeFamilyPolicy, NativeFamilyFence } from "./native-family-gates"
import type { NativeProductChannel, ProductTaskObservation, ProductBoundaryObservation, ProductPreparedBoundary } from "./native-product-contract"

const id = z.string().min(1).max(240).regex(/^[^\s\x00-\x1f\x7f]+$/)
// Official subagent Input (agent/description/prompt + optional model/sessionID/background).
// Checked against owned published-core 2.0.22 tool/plugin/subagent source, not a V1 Task schema.
const inputSchema = z.object({ agent: z.string(), description: z.string(), prompt: z.string(), model: z.string().optional(),
  sessionID: id.optional(), background: z.boolean().optional() }).strict()
const equal = (a: unknown, b: unknown) => canonicalAuthority(a) === canonicalAuthority(b)
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value))
export interface NativeProductOptions {
  journal: DerivedCallBusinessDependencies["journal"]
  store: DerivedCallAuthorityDependencies["store"]
  host: DerivedCallAuthorityDependencies["host"]
  native: DerivedCallAuthorityDependencies["native"]
  environment: Omit<Parameters<typeof createMissionNativePreparation>[0], "authority">
  /** Missing actual producer refuses construction. No default/test-mode/ENV fallback. */
  channel: NativeProductChannel
}
export type NativeProductClaim = Readonly<{ kind: "native-product-claim" }>
export type NativeProductBound = Readonly<{ kind: "native-product-bound" }>

/** One journal/business/derived authority/publication and real fresh preparation.
 * Does not install hooks, launch SDK/runtime, create/prompt a child, reconcile
 * background work, or claim native atomic report commit qualification. */
export function createNativeProductAdmissions(options: NativeProductOptions): {
  admissions: NativeTaskAdmissions<NativeProductClaim, NativeProductBound>
  gates: NativeFamilyPolicy<object, object>
  authorizeNativeReport: MissionNativeReportAuthorization
  dispose(): void
} {
  const c = options.channel
  const unavailable = () => rejectAuthority("policy-unqualified")
  if (!c?.sdk || c.sdk.missionsProtocol !== NATIVE_MISSIONS_PROTOCOL || c.sdk.missionsAuthorityProtocol !== NATIVE_MISSIONS_AUTHORITY_PROTOCOL
    || !Buffer.isBuffer(c.proof) || !id.safeParse(c.nonce).success || !id.safeParse(c.incarnationID).success) unavailable()
  for (const method of [...MISSIONS_CHANNEL_METHODS, ...MISSIONS_AUTHORITY_METHODS]) if (typeof c.sdk[method] !== "function") unavailable()
  for (const method of ["assertCurrent", "observeTask", "assertTask", "assertActualChild", "reserveRaw", "guardRawContinuation", "callContext", "childBoundary",
    "observeBoundary", "assertBoundary", "prepareBoundary", "executeContext", "retainBoundary", "observeReturn", "reportContext", "failureObserved",
    "revokeCaptures", "releaseManagedReferences"] as const) if (typeof c[method] !== "function") unavailable()
  for (const [adapter, methods] of [[c.business, ["assertCurrent", "readCurrentJournal", "readCurrentAuthority", "readChild", "readChildCurrent",
    "resolveRoot", "resolveRootCurrent", "assertNativeIdle", "assertNativeIdleCurrent"]], [c.invocations, ["verify"]],
    [c.publication, ["authorize"]], [c.preparation, ["prepare", "current"]]] as const) {
    for (const method of methods) if (!adapter || typeof (adapter as unknown as Record<string, unknown>)[method] !== "function") unavailable()
  }
  let disposed = false
  const lifetime = new AbortController()
  const voidGuard = (operation: () => void) => { if (operation() !== undefined) unavailable() }
  const observation = c.sdk.verifyMissionsAuthority(c.channel, c.proof)
  if (observation.nonce !== c.nonce || observation.writer.incarnationID !== c.incarnationID
    || observation.writer.projectID !== options.store.projectID || observation.writer.projectCanonical !== options.store.projectCanonical) unavailable()
  const observationDigest = authorityDigest(plain(observation))
  const current = (purpose: "send" | "evidence" = "evidence") => {
    if (disposed) unavailable()
    voidGuard(() => c.sdk.missionsAssertChannel(c.channel))
    voidGuard(() => c.sdk.missionsAssertRegistration(c.channel, c.registration))
    voidGuard(() => c.sdk.assertMissionsAuthority(c.channel, c.proof, observationDigest))
    if (purpose === "send") voidGuard(() => c.sdk.assertMissionsHuman(c.channel, c.humanLease))
    voidGuard(() => c.assertCurrent(purpose))
  }
  current("send")
  const business = new SharedJournalDerivedCallBusiness({ journal: options.journal, store: options.store, host: options.host, channel: c.business })
  const authority = new DerivedCallAuthority({ store: options.store, host: options.host, native: options.native, business, invocations: c.invocations })
  const publication = new DerivedCallPublication({ authority, business, channel: c.publication })
  const environment = createMissionNativePreparation({ ...options.environment, authority: {
    async prepare(identity, signal) { current("send"); await c.preparation.prepare(identity, signal); current("send") },
    current(identity) { current("send"); return c.preparation.current(identity) },
  } })
  type Claim = { invocation: NativeTaskInvocation; observation: ProductTaskObservation; body?: DerivedCallBody;
    entry?: { assertCurrent(): true }; entered: boolean; effectCurrent?: () => void }
  type Bound = { claim: Claim; childSessionID: string; prepared?: PreparedMissionNativeExecution; state: "active" | "outstanding" | "ended" }
  const claims = new WeakMap<object, Claim>(), bounds = new WeakMap<object, Bound>()
  const boundaries = new WeakMap<object, { boundary: Parameters<NativeProductChannel["observeBoundary"]>[0]; observation: ProductBoundaryObservation;
    effectCurrent?: () => true }>()
  const receipts = new Set<PreparedMissionNativeExecution>()
  const owned = (value: ProductTaskObservation | ProductBoundaryObservation) => {
    if (value.scope === "owned") {
      current("send")
      const actual = derivedExecutionSchema.parse(plain(value.execution))
      if (!actual.agent || !actual.model) unavailable()
      voidGuard(() => c.sdk.assertMissionsFamily(c.channel, value.familyClaim, value.family))
    }
    else if (value.scope !== "unowned" || !value.permit) unavailable()
  }
  const taskCurrent = (invocation: NativeTaskInvocation, claim?: Claim) => {
    current(); if (claim && !equal(claim.invocation, invocation)) unavailable()
    if (claim) owned(claim.observation)
    voidGuard(() => c.assertTask(invocation, claim?.observation))
    claim?.effectCurrent?.()
  }
  const check = (fence: NativeTaskFence | NativeFamilyFence) => { current(); fence.signal.throwIfAborted(); voidGuard(fence.assertCurrent) }
  const signal = (fence: NativeTaskFence | NativeFamilyFence) => AbortSignal.any([lifetime.signal, fence.signal])
  const required = (handle: object) => { const claim = claims.get(handle); if (!claim) return unavailable(); return claim }
  const bound = (handle: object) => { const value = bounds.get(handle); if (!value) return unavailable(); return value }
  const execution = (invocation: NativeTaskInvocation, value: ProductTaskObservation) => {
    const input = inputSchema.parse(invocation.nativeInput)
    if (value.scope === "owned") {
      const actual = derivedExecutionSchema.parse(plain(value.execution))
      if (!actual.agent || !actual.model || actual.agent !== input.agent) unavailable()
      // Official parser; missing override requires genuine actual runtime resolution.
      if (input.model !== undefined && !equal(plain(Model.Ref.parse(input.model)), actual.model)) unavailable()
    }
    return input
  }
  const prepare = async (prepared: ProductPreparedBoundary, fence: NativeTaskFence | NativeFamilyFence, claim?: Claim, childID?: string) => {
    check(fence)
    if (claim) {
      const identity = prepared.identity, body = claim.body
      if (identity.sessionID !== childID || identity.parentSessionID !== claim.invocation.sessionID
        || identity.execution.callerSessionID !== claim.invocation.sessionID || identity.execution.messageID !== claim.invocation.messageID
        || identity.execution.callID !== claim.invocation.id || identity.execution.boundary !== "child-first-prompt"
        || !equal(plain(prepared.execution), plain(claim.observation.scope === "owned" ? claim.observation.execution : {}))) unavailable()
      if (body ? identity.scope !== "bound-native-child" || !equal(identity.task, claim.invocation.mission)
        : identity.scope !== "owned-family" || identity.task !== undefined) unavailable()
    }
    const receipt = await environment.prepare(prepared.identity, signal(fence))
    receipts.add(receipt)
    try { check(fence); receipt.current(); return receipt }
    catch (error) { receipts.delete(receipt); receipt.dispose(); throw error }
  }
  const enter = (claim: Claim, fence: NativeTaskFence) => {
    check(fence); taskCurrent(claim.invocation, claim)
    if (!claim.entered) { claim.entry?.assertCurrent(); claim.entered = true }
  }
  const makeBody = async (invocation: NativeTaskInvocation, observed: ProductTaskObservation): Promise<DerivedCallBody> => {
    if (observed.scope !== "owned" || !invocation.mission) return unavailable()
    const ref = invocation.mission, snapshot = await options.journal.snapshot(), host = await options.host.read()
    const mission = snapshot.missions.find(mission => mission.id === ref.missionID), task = mission?.tasks.find(task => task.key === ref.taskKey)
    if (snapshot.discardedEvents || snapshot.controlUnavailable || !host?.signer || !host.mirror || !mission || !task
      || task.contractGeneration !== ref.generation || task.executionMode?.kind !== "native" || mission.projectID !== host.binding.projectID
      || mission.projectCanonical !== host.binding.projectCanonical || mission.coordinatorSessionId !== host.binding.coordinatorSessionID) return unavailable()
    if (host.signer.signerDigest !== observation.signerDigest || host.signer.provisioningGeneration !== observation.provisioningGeneration
      || host.binding.namespace !== observation.writer.namespace || host.binding.coordinatorSessionID !== observation.writer.coordinatorSessionID
      || !equal(host.binding.roots, observation.writer.roots)) return unavailable()
    const mode = task.executionMode, parent = mode.parentTaskKey === null ? undefined : mission.tasks.find(task => task.key === mode.parentTaskKey)
    if (mode.parentTaskKey !== null && (!parent?.contractGeneration || !parent.actorSessionId)) return unavailable()
    if ((parent?.actorSessionId ?? mission.coordinatorSessionId) !== invocation.sessionID) return unavailable()
    const input = execution(invocation, observed), sessionID = input.sessionID
    const source = mode.reuseFromTaskKey ? mission.tasks.find(task => task.key === mode.reuseFromTaskKey) : undefined
    if (mode.reuseFromTaskKey && (!source?.contractGeneration || !sessionID || source.actorSessionId !== sessionID)) return unavailable()
    if (sessionID && !source && task.actorSessionId !== sessionID || !sessionID && (source || task.actorSessionId)) return unavailable()
    // Requested constraints stay in the signed task contract. Complete actual
    // resolution remains mandatory native evidence, never invented defaults.
    if (!matchesExecution(task.execution, observed.execution)) return unavailable()
    if (sessionID) {
      const previousTask = source ?? task
      const accepted = (await options.store.read()).derivedCalls?.filter(call => call.state === "ended"
        && call.child?.sessionID === sessionID && call.signed.body.missionID === mission.id
        && call.signed.body.task.taskKey === previousTask.key && call.signed.body.task.generation === previousTask.contractGeneration
        && sameNativeCall(previousTask.nativeExecution?.binding, derivedNativeBinding(call.signed.body))) ?? []
      // Optional constraints do not authorize switching a retained actor's
      // originally accepted actual agent/model/variant on continuation or reuse.
      if (accepted.length !== 1 || !equal(plain(observed.execution), accepted[0].child!.execution)) return unavailable()
    }
    const identity: Omit<DerivedCallBody, "reservationID"> = { ...host.binding, version: 1, policy: DERIVED_CALL_POLICY,
      epoch: host.mirror.epoch, provisioningGeneration: host.signer.provisioningGeneration, signerDigest: host.signer.signerDigest,
      task: { taskKey: task.key, generation: ref.generation }, taskContractDigest: derivedTaskContractDigest(mission, task),
      parentTask: parent ? { taskKey: parent.key, generation: parent.contractGeneration! } : null,
      parentSessionID: invocation.sessionID, parentMessageID: invocation.messageID, toolCallID: invocation.id,
      choice: source ? { kind: "reuse", sessionID: sessionID!, fromTask: { taskKey: source.key, generation: source.contractGeneration! } }
        : sessionID ? { kind: "continue", sessionID } : { kind: "new" }, execution: plain(task.execution ?? {}), root: observed.root }
    return parseDerivedCallBody({ ...identity, reservationID: derivedReservationID(identity) })
  }
  const admissions: NativeTaskAdmissions<NativeProductClaim, NativeProductBound> = {
    assertCurrent(invocation, reservation) { taskCurrent(invocation, reservation ? required(reservation.claim) : undefined) },
    async reserve(invocation, fence) {
      check(fence)
      const observation = await c.observeTask(invocation, signal(fence)); check(fence); owned(observation); execution(invocation, observation)
      const claim: Claim = { invocation: structuredClone(invocation), observation, entered: false }
      const scopedCheck = () => { check(fence); taskCurrent(invocation, claim) }
      if (invocation.mission) {
        claim.body = await makeBody(invocation, observation); scopedCheck()
        const proof = await c.callContext({ invocation, observation, body: claim.body, purpose: "reserve" }, signal(fence)); scopedCheck()
        await authority.reserve(claim.body, proof, signal(fence)); scopedCheck()
        claim.entry = await authority.admitNative(claim.body.reservationID, proof, signal(fence)); scopedCheck()
      } else if (observation.scope === "owned") { await c.reserveRaw(invocation, observation, signal(fence)); scopedCheck() }
      taskCurrent(invocation, claim)
      // New calls enter immediately; explicit continuations enter only after guardContinuation.
      if (invocation.nativeInput.sessionID === undefined) enter(claim, fence)
      const handle: NativeProductClaim = Object.freeze({ kind: "native-product-claim" }); claims.set(handle, claim)
      return { scope: observation.scope === "owned" ? "owned" : "unowned", claim: handle }
    },
    async guardContinuation(invocation, reservation, childSessionID, fence) {
      const claim = required(reservation.claim); taskCurrent(invocation, claim); check(fence)
      if (invocation.nativeInput.sessionID !== childSessionID || claim.entered) unavailable()
      if (claim.body) await business.assertIdle(childSessionID, signal(fence), claim.body)
      else await c.guardRawContinuation(invocation, claim.observation, childSessionID, signal(fence))
      enter(claim, fence)
    },
    async bindActualChild(invocation, reservation, childSessionID, fence) {
      const claim = required(reservation.claim); taskCurrent(invocation, claim); check(fence)
      if (!claim.entered || !id.safeParse(childSessionID).success
        || invocation.nativeInput.sessionID !== undefined && invocation.nativeInput.sessionID !== childSessionID) unavailable()
      voidGuard(() => c.assertActualChild(invocation, claim.observation, childSessionID))
      if (claim.body) {
        const context = await c.callContext({ invocation, observation: claim.observation, body: claim.body, purpose: "bind", childSessionID }, signal(fence)); check(fence)
        const request = { ...context, reservationID: claim.body.reservationID, childSessionID }
        await publication.publishBinding(request, signal(fence)); check(fence)
        await publication.activateBinding(request, signal(fence)); check(fence)
      }
      let prepared: PreparedMissionNativeExecution | undefined
      let execute: { assertCurrent(): true } | undefined
      if (claim.observation.scope === "owned") {
        const identity = await c.childBoundary(invocation, claim.observation, childSessionID, claim.body, signal(fence)); check(fence)
        if (claim.body) {
          const proof = await c.callContext({ invocation, observation: claim.observation, body: claim.body, purpose: "execute", childSessionID }, signal(fence)); check(fence)
          execute = await authority.authorize(claim.body.reservationID, "execute", proof, signal(fence)); check(fence)
        }
        prepared = await prepare(identity, fence, claim, childSessionID)
      }
      check(fence); taskCurrent(invocation, claim); execute?.assertCurrent(); prepared?.current()
      // Adapter repeats assertCurrent after forwarded (possibly async) progress,
      // immediately before the original native executor can own its prompt.
      claim.effectCurrent = () => { execute?.assertCurrent(); prepared?.current() }
      const handle: NativeProductBound = Object.freeze({ kind: "native-product-bound" })
      bounds.set(handle, { claim, childSessionID, prepared, state: "active" }); return handle
    },
    async launchReturned(invocation, reservation, handle, result, fence) {
      const value = bound(handle); if (value.claim !== required(reservation.claim) || result.metadata?.status !== "running"
        || result.metadata.sessionID !== value.childSessionID) unavailable()
      taskCurrent(invocation, value.claim); check(fence); value.state = "outstanding"
      value.claim.effectCurrent = undefined
      value.prepared?.dispose(); if (value.prepared) receipts.delete(value.prepared)
    },
    async returned(invocation, reservation, handle, result, fence) {
      const value = bound(handle); if (value.claim !== required(reservation.claim) || value.state !== "active"
        || result.metadata?.status !== "completed" || result.metadata.sessionID !== value.childSessionID) unavailable()
      check(fence); taskCurrent(invocation, value.claim)
      const outcome = await c.observeReturn(invocation, value.claim.observation, value.childSessionID, result, signal(fence)); check(fence)
      if (outcome !== "returned") unavailable()
      // Exact authenticated end is not a new send. The journal end fence would
      // correctly invalidate a send lease; never use it to block authority end.
      value.claim.effectCurrent = undefined
      if (value.claim.body) {
        const body = value.claim.body, context = await c.callContext({ invocation, observation: value.claim.observation, body,
          purpose: "end", childSessionID: value.childSessionID, outcome: "returned" }, signal(fence)); check(fence)
        const request = { ...context, reservationID: body.reservationID, childSessionID: value.childSessionID, outcome: "returned" as const }
        await publication.publishEnd(request, signal(fence)); check(fence)
        await publication.endAuthority(request, signal(fence)); check(fence)
      }
      value.state = "ended"; value.prepared?.dispose(); if (value.prepared) receipts.delete(value.prepared)
    },
    async failureObserved(failure) { await c.failureObserved(failure) },
  }
  const gates: NativeFamilyPolicy<object, object> = {
    assertCurrent(boundary, resolution) {
      current(); const value = resolution ? boundaries.get(resolution.scope === "owned" ? resolution.membership : resolution.permit) : undefined
      if (resolution && (!value || value.boundary !== boundary)) unavailable()
      if (value) owned(value.observation)
      voidGuard(() => c.assertBoundary(boundary, value?.observation))
      value?.effectCurrent?.()
    },
    async resolve(boundary, fence) {
      check(fence); const observation = await c.observeBoundary(boundary, signal(fence)); check(fence); owned(observation)
      if (boundary.boundary === "shell.create.before" && observation.scope === "owned") unavailable()
      const handle = Object.freeze({}); boundaries.set(handle, { boundary, observation })
      return observation.scope === "owned" ? { scope: "owned", membership: handle } : { scope: "unrelated", permit: handle }
    },
    async prepare(boundary, resolution, fence) {
      check(fence); const value = boundaries.get(resolution.scope === "owned" ? resolution.membership : resolution.permit)
      if (!value || value.boundary !== boundary) return unavailable()
      owned(value.observation); voidGuard(() => c.assertBoundary(boundary, value.observation))
      if (value.observation.scope === "unowned") { check(fence); return }
      const prepared = await c.prepareBoundary(boundary, value.observation, signal(fence)); check(fence)
      if (!equal(plain(prepared.execution), plain(value.observation.execution))) unavailable()
      // Official model request/transport hooks expose actual agent/model. Do not
      // replace these fields or substitute a mutable SessionInfo observation.
      if ("event" in boundary && "agent" in boundary.event && "model" in boundary.event
        && (boundary.event.agent !== prepared.execution.agent || !equal(plain(boundary.event.model), plain(prepared.execution.model)))) unavailable()
      let authorized: { assertCurrent(): true } | undefined
      if (value.observation.reservationID) {
        const record = await authority.read(value.observation.reservationID); check(fence)
        if (!record || !record.child || !equal(plain(prepared.execution), record.child.execution)
          || !matchesExecution(record.signed.body.execution, prepared.execution)
          || prepared.identity.sessionID !== record.child.sessionID || !equal(prepared.identity.task,
            { missionID: record.signed.body.missionID, ...record.signed.body.task })) return unavailable()
        const proof = await c.executeContext(boundary, value.observation, record.signed.body, signal(fence)); check(fence)
        authorized = await authority.authorize(record.signed.body.reservationID, "execute", proof, signal(fence)); check(fence)
      } else if (prepared.identity.scope !== "owned-family" || prepared.identity.task) unavailable()
      const receipt = await prepare(prepared, fence)
      const effectCurrent = (): true => { current(); authorized?.assertCurrent(); return receipt.current() }
      value.effectCurrent = effectCurrent
      try {
        check(fence); effectCurrent()
        voidGuard(() => c.retainBoundary(boundary, value.observation, { current: effectCurrent,
          dispose: () => { receipts.delete(receipt); receipt.dispose() } }))
        check(fence); effectCurrent()
      } catch (error) { receipts.delete(receipt); receipt.dispose(); throw error }
    },
  }
  return { admissions, gates,
    async authorizeNativeReport(request) {
      request = structuredClone(request)
      current("evidence")
      const input = await c.reportContext(structuredClone(request), lifetime.signal); current("evidence")
      const authorized = await publication.authorizeReport({ ...input, request }, lifetime.signal); current("evidence")
      return { call: authorized.call, current: () => { current("evidence"); return authorized.current() } }
    },
    dispose() {
      if (disposed) return
      disposed = true; lifetime.abort()
      try { voidGuard(() => c.revokeCaptures()) }
      catch (error) { environment.dispose(); receipts.clear(); throw error }
      environment.dispose(); receipts.clear(); voidGuard(() => c.releaseManagedReferences())
    },
  }
}
