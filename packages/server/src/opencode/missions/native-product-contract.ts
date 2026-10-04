import type * as Tool from "@opencode/plugin/promise/tool"
import type { NativeMissionsAuthoritySDK } from "../../host-lifetime/native-missions-contract"
import type { DerivedBusinessChannel } from "../../missions/derived-call-business"
import type { DerivedInvocationVerifier, DerivedCallBody, DerivedExecution } from "../../missions/derived-call-protocol"
import type { DerivedCallPublicationChannel, DerivedCallPublicationContext } from "../../missions/derived-call-publication"
import type { MissionNativePreparationAuthority, MissionNativePreparationIdentity } from "../../server/routes/mission-native-preparation"
import type { AuthorityRoot } from "../../missions/authority-protocol"
import type { MissionNativeReportRequest } from "../../missions/control-types"
import type { NativeTaskInvocation, NativeTaskFailure } from "./native-task-adapter"
import type { NativeFamilyBoundary } from "./native-family-gates"

export type ProductOwnedScope = { readonly scope: "owned"; readonly family: string; readonly familyClaim: object;
  readonly root: AuthorityRoot; readonly execution: Required<DerivedExecution> }
export type ProductScope = ProductOwnedScope | { readonly scope: "unowned"; readonly permit: object }
export type ProductTaskObservation = ProductScope & { readonly reference: object }
export type ProductBoundaryObservation = ProductScope & { readonly reference: object; readonly reservationID?: string }
export interface ProductPreparedBoundary {
  readonly identity: MissionNativePreparationIdentity
  /** Actual resolved agent/model/variant at THIS execution boundary, not session settings. */
  readonly execution: Required<DerivedExecution>
}

/** REQUIRED FUTURE runtime producer operations, not implemented by this module.
 * No public SDK producer currently exists. Each reference is a retained native
 * type-tagged capability bound to channel/registration/writer/call/lifecycle.
 * A JS object/method/boolean does NOT mint it. The host must implement these
 * operations using the native-missions-contract ABI, not an HTTP/plugin shim.
 * No closure in these in-process adapters may be serialized over native RPC. */
export interface NativeProductChannel {
  readonly sdk: NativeMissionsAuthoritySDK
  readonly channel: object
  readonly registration: object
  readonly humanLease: object
  readonly proof: Buffer
  readonly nonce: string
  readonly incarnationID: string
  readonly business: DerivedBusinessChannel
  readonly invocations: DerivedInvocationVerifier
  readonly publication: DerivedCallPublicationChannel
  readonly preparation: MissionNativePreparationAuthority
  /** Synchronous native writer/lifecycle check. Report/end may retain historical
   * evidence without live human send privilege; construction and sends may not. */
  assertCurrent(purpose: "send" | "evidence"): void
  observeTask(invocation: NativeTaskInvocation, signal: AbortSignal): Promise<ProductTaskObservation>
  assertTask(invocation: NativeTaskInvocation, observation?: ProductTaskObservation): void
  assertActualChild(invocation: NativeTaskInvocation, observation: ProductTaskObservation, childSessionID: string): void
  /** Durable single-use raw-family capacity before birth, NO task/report/grant
   * privilege. Same native actor-cap writer as declared calls; not a JS counter.
   * Ambiguous admission/end retains the claim for exact native reconciliation. */
  reserveRaw(invocation: NativeTaskInvocation, observation: ProductOwnedScope & { reference: object }, signal: AbortSignal): Promise<void>
  guardRawContinuation(invocation: NativeTaskInvocation, observation: ProductTaskObservation, childSessionID: string, signal: AbortSignal): Promise<void>
  /** Verbatim transport from active host owner: never choose/reissue family proof.
   * reserve also requires the native shared actor-cap claim before birth; the
   * derived authority retains its durable journal-backed reservation separately. */
  callContext(input: { invocation: NativeTaskInvocation; observation: ProductTaskObservation; body: Readonly<DerivedCallBody>;
    purpose: "reserve" | "bind" | "execute" | "end"; childSessionID?: string; outcome?: "returned" }, signal: AbortSignal): Promise<DerivedCallPublicationContext>
  childBoundary(invocation: NativeTaskInvocation, observation: ProductTaskObservation, childSessionID: string,
    body: Readonly<DerivedCallBody> | undefined, signal: AbortSignal): Promise<ProductPreparedBoundary>
  observeBoundary(boundary: NativeFamilyBoundary, signal: AbortSignal): Promise<ProductBoundaryObservation>
  assertBoundary(boundary: NativeFamilyBoundary, observation?: ProductBoundaryObservation): void
  prepareBoundary(boundary: NativeFamilyBoundary, observation: ProductBoundaryObservation, signal: AbortSignal): Promise<ProductPreparedBoundary>
  executeContext(boundary: NativeFamilyBoundary, observation: ProductBoundaryObservation, body: Readonly<DerivedCallBody>,
    signal: AbortSignal): Promise<DerivedCallPublicationContext>
  /** In-process receipt lifetime handshake with the real native effect owner.
   * It repeats current immediately before effects and releases in native finally.
   * Cannot serialize these closures or implement retirement with a timer. */
  retainBoundary(boundary: NativeFamilyBoundary, observation: ProductBoundaryObservation,
    receipt: { current(): true; dispose(): void }): void
  /** Read-only exact foreground return observation. Unknown/background retains
   * outstanding claims. Never infer end from text, report, elapsed time or idle. */
  observeReturn(invocation: NativeTaskInvocation, observation: ProductTaskObservation, childSessionID: string,
    result: Tool.Result, signal: AbortSignal): Promise<"returned" | "unknown">
  /** Authenticate THIS reporter's actual session/Tool/message incarnation and
   * independently select the exact accepted historical delegation. A delegation
   * proof is not reporter authority. MainControl owns native-return routing;
   * this preparation never publishes a report or wakes/outboxes a coordinator. */
  reportContext(request: MissionNativeReportRequest, signal: AbortSignal): Promise<DerivedCallPublicationContext & { reservationID: string }>
  failureObserved(failure: NativeTaskFailure<object, object>): Promise<void>
  /** In-process captured operations are revoked FIRST. Only references whose
   * owned acquisition is proven may be released; never family inventory/daemon.
   * Must not release durable capacity or infer rollback from missing ACKs. */
  revokeCaptures(): void
  releaseManagedReferences(): void
}
