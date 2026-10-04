import type { ManagedAuthorityObservation, PrivateManagedAuthorityBridge } from "../missions/host-authority/qualification"
import type { HostAuthorityDescriptor } from "../missions/host-authority/model"
import type { AuthorityBinding } from "../missions/authority-protocol"

export const NATIVE_MISSIONS_PROTOCOL = "codenomad.missions.channel.v1"
export const NATIVE_MISSIONS_AUTHORITY_PROTOCOL = "codenomad.missions.authority.v1"
export const NATIVE_MISSIONS_MAX_BYTES = 256 * 1024
export const NATIVE_MISSIONS_MAX_FAMILIES = 32

/** Native projections, not serialized capabilities. Every object argument below
 * must be checked with a distinct native type tag and retained owner identity.
 * The current OpenCode public plugin Context has no producer for these objects.
 * Adding JS methods with these names never mints a production binding. */
export interface NativeMissionsSDK {
  readonly missionsProtocol: typeof NATIVE_MISSIONS_PROTOCOL
  openMissionsChannel(runtimeSession: object, challenge: Buffer): Promise<object>
  missionsRelease(handle: object): void
  missionsAssertChannel(channel: object): void
  missionsInventory(channel: object): object[]
  /** Native diagnostic projection; complete:false/unknown cannot qualify. */
  missionsReadWriterInventory(channel: object): unknown
  missionsAssertQuiescence(channel: object): void
  missionsAssertRegistration(channel: object, registration: object): void
  missionsAcquireHumanLease(channel: object, registration: object, ttlMs: number): object
  missionsAssertHumanLease(lease: object): void
  missionsBeginCommit(channel: object, registration: object, lease: object): object
  missionsAssertCommitGuard(guard: object): void
  /** Current addon consumes the guard and refuses missing transaction producer. */
  missionsCommit(guard: object): void
}

/** Required end-to-end producer ABI. Absence is a hard refusal, NOT a fallback
 * to process receipts, HTTP, storage.set(), caller inventory or JS callbacks.
 * These methods cannot be implemented by a plugin adapter alone: registration,
 * complete inventory, disposal and transaction publication belong to runtime
 * internals. Native guardian primitives alone do not satisfy this interface. */
export interface NativeMissionsAuthoritySDK extends NativeMissionsSDK {
  readonly missionsAuthorityProtocol: typeof NATIVE_MISSIONS_AUTHORITY_PROTOCOL
  readMissionsAuthority(channel: object): NativeMissionsAuthorityRecord
  readMissionsDiscovery(channel: object): Promise<{ globalDirectory: string; configDigest: string }>
  handshakeMissionsAuthority(channel: object, bytes: Buffer): Promise<Buffer>
  verifyMissionsAuthority(channel: object, proof: Buffer): ManagedAuthorityObservation
  assertMissionsAuthority(channel: object, proof: Buffer, observationDigest: string): void
  assertMissionsFamily(channel: object, familyClaim: object, family: string): void
  admitMissionsHuman(channel: object, invocation: Buffer): Promise<object>
  revokeMissionsHuman(channel: object, invocationID: string): void
  assertMissionsHuman(channel: object, lease: object): void
  acquireMissionsCommit(channel: object, lease: object, publicationDigest: string): object
  publishMissionsCommit(channel: object, guard: object, publication: Buffer): Buffer
  releaseMissionsCommit(channel: object, guard: object): void
}

export interface NativeMissionsAuthorityRecord {
  privateRoot: string
  descriptor: HostAuthorityDescriptor
  scope: Pick<AuthorityBinding, "namespace" | "projectID" | "projectCanonical">
  physicalResolver: "win32-local"
}
export type NativeMissionsHandshake = Parameters<PrivateManagedAuthorityBridge["handshake"]>[0]

export const MISSIONS_CHANNEL_METHODS = ["openMissionsChannel", "missionsRelease", "missionsAssertChannel",
  "missionsInventory", "missionsReadWriterInventory", "missionsAssertQuiescence",
  "missionsAssertRegistration", "missionsAcquireHumanLease", "missionsAssertHumanLease",
  "missionsBeginCommit", "missionsAssertCommitGuard", "missionsCommit"] as const
export const MISSIONS_AUTHORITY_METHODS = [
  "readMissionsAuthority", "readMissionsDiscovery", "handshakeMissionsAuthority", "verifyMissionsAuthority",
  "assertMissionsAuthority", "assertMissionsFamily", "admitMissionsHuman", "revokeMissionsHuman", "assertMissionsHuman",
  "acquireMissionsCommit", "publishMissionsCommit", "releaseMissionsCommit",
] as const
