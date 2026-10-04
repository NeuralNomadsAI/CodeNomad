import { authorityDigest, rejectAuthority } from "./authority-protocol"
import { assertSynchronousAuthorityGuard } from "./authority-synchronous"
import { runMissionExclusive } from "./exclusive"
import { MISSION_SCHEMA_VERSION, type MissionEvent, type MissionNativeBinding } from "./model"
import type { MissionNativeReportRequest } from "./control-types"
import type { DerivedCallAuthority } from "./derived-call-authority"
import type { DerivedCallBody, DerivedCallRecord, DerivedChildBinding } from "./derived-call-protocol"
import { SharedJournalDerivedCallBusiness, derivedNativeBinding } from "./derived-call-business"

/** Forward native-channel transport fields verbatim. No nonce/proof issuer,
 * environment token, family proof selection or RPC-callable signed closure. */
export interface DerivedCallPublicationContext { nonce: string; incarnationID: string; proof: unknown }
export interface DerivedCallPublicationRequest extends DerivedCallPublicationContext {
  reservationID: string; childSessionID: string
}
export interface DerivedCallEndRequest extends DerivedCallPublicationRequest { outcome: "returned" | "error" }
export interface DerivedPublicationAuthorization extends DerivedCallPublicationContext {
  record: Readonly<DerivedCallRecord>; purpose: "bind" | "report" | "end"; childSessionID: string
  outcome?: "returned" | "error"; reportRequest?: MissionNativeReportRequest; signal: AbortSignal
}
/** Trusted native-host channel owner supplies this in-process adapter. It must
 * authenticate the actual invocation, nonce/incarnation, protected signer/grant,
 * physical ownership and native lifecycle/connection facts. bind requires live
 * send admission; report/end retain historical evidence only. assertCurrent is
 * a local guarded-write lease, NOT a function transported through native RPC. */
export interface DerivedCallPublicationChannel {
  authorize(input: DerivedPublicationAuthorization): Promise<{ assertCurrent(): true }>
}
export interface DerivedCallPublicationDependencies {
  authority: Pick<DerivedCallAuthority, "read" | "bind" | "end" | "authorize">
  business: SharedJournalDerivedCallBusiness
  channel: DerivedCallPublicationChannel
}
export interface DerivedCallPublicationReceipt {
  eventID: string; body: Readonly<DerivedCallBody>; child: Readonly<DerivedChildBinding>
}
export function derivedCallEventID(reservationID: string, purpose: "bind" | "end"): string {
  if (!/^dcall_[a-f0-9]{48}$/.test(reservationID)) rejectAuthority("invalid-intent")
  return `dpub_${authorityDigest({ reservationID, purpose }).slice(0, 48)}`
}

/** Shared business publication ONLY, outside authority transactions. Explicit
 * activation and authority-end methods are separate. A lost write/ack or a
 * projection/metadata tear stays ambiguous; no creator, prompt, retry or repair.
 * Every append passes a mandatory sync guard through MissionJournal to the real
 * authorized storage write, including policy storage's post-await fence. This
 * plumbing is not cross-process native commit attestation. */
export class DerivedCallPublication {
  constructor(private readonly deps: DerivedCallPublicationDependencies) {
    if (!deps.channel) rejectAuthority("policy-unqualified")
  }
  async publishBinding(input: DerivedCallPublicationRequest, signal: AbortSignal): Promise<DerivedCallPublicationReceipt> {
    input = { ...this.proof(input), reservationID: input.reservationID, childSessionID: input.childSessionID }
    this.context(input, signal)
    const record = await this.record(input.reservationID)
    if (record.state !== "invoking") rejectAuthority("authorization-blocked")
    const body = record.signed.body, business = this.deps.business
    const lease = await this.admit(record, "bind", input, signal)
    const child = await business.child(input.childSessionID, body, "bind")
    const eventID = derivedCallEventID(input.reservationID, "bind")
    await runMissionExclusive(`mutation:${business.journal.projectToken}`, async () => {
      if (await business.journal.event(body.missionID, eventID)) rejectAuthority("request-conflict")
      const actor = await business.prepareBinding(body, child)
      const base = { version: MISSION_SCHEMA_VERSION, id: eventID, missionID: body.missionID, projectID: body.projectID,
        createdAt: await business.nextEventTime(body), taskKey: body.task.taskKey, binding: derivedNativeBinding(body) }
      const event: MissionEvent = body.choice.kind === "continue"
        ? { ...base, type: "task.native-call-started", childSessionID: child.sessionID }
        : { ...base, type: "task.native-bound", actor }
      const current = () => { this.fence(lease, signal); this.businessFence(() => business.assertBindingPublicationCurrent(body, child)) }
      current()
      await business.journal.append(event, current)
      await business.accepted(body, child, "bind")
      this.fence(lease, signal); this.businessFence(() => business.assertCurrent(body, "bind"))
    })
    return { eventID, body: structuredClone(body), child: structuredClone(child) }
  }
  /** Separate explicit phase, after actual child progress and shared projection.
   * This method never republishes a missing/rejected event or invokes execution. */
  async activateBinding(input: DerivedCallPublicationRequest, signal: AbortSignal): Promise<DerivedCallRecord> {
    input = { ...this.proof(input), reservationID: input.reservationID, childSessionID: input.childSessionID }
    this.context(input, signal)
    return this.deps.authority.bind(input.reservationID, input.childSessionID, this.proof(input), signal)
  }
  async publishEnd(input: DerivedCallEndRequest, signal: AbortSignal): Promise<DerivedCallPublicationReceipt> {
    input = { ...this.proof(input), reservationID: input.reservationID, childSessionID: input.childSessionID, outcome: input.outcome }
    this.context(input, signal)
    if (input.outcome !== "returned" && input.outcome !== "error") rejectAuthority("invalid-intent")
    const record = await this.record(input.reservationID)
    if (!record.child || record.child.sessionID !== input.childSessionID
      || record.state !== "active" && record.state !== "ended" || record.ended && record.ended !== input.outcome) rejectAuthority("binding-mismatch")
    const body = record.signed.body, child = record.child, business = this.deps.business
    const lease = await this.admit(record, "end", input, signal, input.outcome)
    const eventID = derivedCallEventID(input.reservationID, "end")
    await runMissionExclusive(`mutation:${business.journal.projectToken}`, async () => {
      if (await business.journal.event(body.missionID, eventID)) rejectAuthority("request-conflict")
      const type = await business.endEventType(body, input.outcome)
      const base = { version: MISSION_SCHEMA_VERSION, id: eventID, missionID: body.missionID, projectID: body.projectID,
        createdAt: await business.nextEventTime(body), taskKey: body.task.taskKey, childSessionID: child.sessionID,
        binding: derivedNativeBinding(body) }
      const event: MissionEvent = type === "task.native-returned" ? { ...base, type }
        : { ...base, type, outcome: input.outcome }
      const current = () => { this.fence(lease, signal); this.businessFence(() => business.assertEndPublicationCurrent(body, child)) }
      current()
      await business.journal.append(event, current)
      await business.ended(body, child, input.outcome)
      this.fence(lease, signal); this.businessFence(() => business.assertCurrent(body, "end"))
    })
    return { eventID, body: structuredClone(body), child: structuredClone(child) }
  }
  /** Only the original immutable authority record. No shared execution/report
   * settlement, and never an automatic response to a torn journal publication. */
  async endAuthority(input: DerivedCallEndRequest, signal: AbortSignal): Promise<DerivedCallRecord> {
    input = { ...this.proof(input), reservationID: input.reservationID, childSessionID: input.childSessionID, outcome: input.outcome }
    this.context(input, signal)
    return this.deps.authority.end(input.reservationID, input.outcome, this.proof(input), signal)
  }
  /** In-process handoff for MainControl.authorizeNativeReport. Actual report Tool
   * and message IDs are forwarded separately: they are NOT the delegating parent
   * Tool/message IDs in derivedNativeBinding(). Native channel authenticates both. */
  async authorizeReport(input: DerivedCallPublicationContext & { reservationID: string; request: MissionNativeReportRequest },
    signal: AbortSignal): Promise<{ call: MissionNativeBinding; current(): true }> {
    input = { ...this.proof(input), reservationID: input.reservationID, request: structuredClone(input.request) }
    this.context(input, signal)
    const record = await this.record(input.reservationID), body = record.signed.body, request = input.request
    if (!record.child || request.contract.missionID !== body.missionID || request.contract.taskKey !== body.task.taskKey
      || request.contract.generation !== body.task.generation || request.sessionID !== record.child.sessionID
      || !this.nativeID(request.toolCallID) || !this.nativeID(request.messageID)) rejectAuthority("binding-mismatch")
    const lease = await this.deps.channel.authorize({ ...this.proof(input), record: structuredClone(record), purpose: "report",
      childSessionID: request.sessionID, reportRequest: structuredClone(request), signal })
    const report = await this.deps.authority.authorize(input.reservationID, "report", this.proof(input), signal)
    const current = (): true => { this.fence(lease, signal); this.businessFence(() => report.assertCurrent()); return true }
    current()
    return { call: derivedNativeBinding(body), current }
  }
  private async record(id: string): Promise<DerivedCallRecord> {
    const record = await this.deps.authority.read(id)
    if (!record) rejectAuthority("authorization-blocked")
    return record
  }
  private async admit(record: DerivedCallRecord, purpose: "bind" | "end", input: DerivedCallPublicationRequest,
    signal: AbortSignal, outcome?: "returned" | "error") {
    const lease = await this.deps.channel.authorize({ ...this.proof(input), record: structuredClone(record), purpose,
      childSessionID: input.childSessionID, ...(outcome ? { outcome } : {}), signal })
    this.fence(lease, signal)
    return lease
  }
  private proof(input: DerivedCallPublicationContext): DerivedCallPublicationContext {
    return { nonce: input.nonce, incarnationID: input.incarnationID, proof: input.proof }
  }
  private context(input: DerivedCallPublicationContext, signal: AbortSignal): void {
    signal.throwIfAborted()
    if (!this.nativeID(input.nonce) || !this.nativeID(input.incarnationID) || input.proof === undefined || input.proof === null) rejectAuthority("policy-unqualified")
  }
  private fence(lease: { assertCurrent(): true }, signal: AbortSignal): void {
    signal.throwIfAborted()
    assertSynchronousAuthorityGuard(() => lease.assertCurrent(), "policy-unqualified")
  }
  private businessFence(current: () => true): void {
    assertSynchronousAuthorityGuard(current, "policy-unqualified")
  }
  private nativeID(value: string): boolean {
    return typeof value === "string" && value.length > 0 && value.length <= 240 && !/[\s\x00-\x1f\x7f]/.test(value)
  }
}
