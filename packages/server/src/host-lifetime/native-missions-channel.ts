import { createHash } from "node:crypto"
import path from "node:path"
import { HostError } from "./protocol"
import { NativeMissionsBinding, type NativeMissionsOpening } from "./native-missions-binding"
import { NATIVE_MISSIONS_MAX_BYTES, NATIVE_MISSIONS_MAX_FAMILIES,
  type NativeMissionsAuthoritySDK, type NativeMissionsHandshake } from "./native-missions-contract"
import { authorityBindingSchema, canonicalAuthority } from "../missions/authority-protocol"
import { descriptorSchema } from "../missions/host-authority/model"
import type { ProtectedNativeMissionHostFactory, QualifiedNativeMissionChannel } from "../missions/durable-host/factory"
import type { HeldFamilyClaim } from "../missions/durable-host/roots"
import { runNativeOriginInvocation } from "./native-missions-invocation"

const CHANNEL_MINT = Symbol("native-missions-qualified-channel")
const channels = new WeakSet<NativeManagedMissionsChannel>()
const factories = new WeakSet<NativeMissionsHostFactory>()
function refuse(): never { throw new HostError("native-missions-authority-unavailable") }
function bytes(value: unknown): Buffer {
  if (!Buffer.isBuffer(value) || !value.length || value.length > NATIVE_MISSIONS_MAX_BYTES) refuse()
  return Buffer.from(value)
}
function invoke<T>(operation: () => T): T { try { return operation() } catch { return refuse() } }
function synchronous(operation: () => void): true {
  // A Promise/thenable is NOT a synchronous final fence. Native N-API assertions
  // return undefined on success and throw on every unavailable fact.
  if (invoke(operation) !== undefined) refuse()
  return true
}
const localWindowsPath = (value: string) => typeof value === "string" && /^[a-z]:[\\/]/i.test(value)
  && path.win32.isAbsolute(value) && !value.includes("\0")

/** Exact existing reference plus separately minted protected-store native tag.
 * Current FamilyAuthorityStore only exports asynchronous JS references; those
 * references alone intentionally cannot satisfy the native producer contract. */
export interface NativeHeldMissionFamily { readonly held: HeldFamilyClaim; readonly nativeClaim: object }
export interface NativeMissionsHostInput {
  readonly binding: NativeMissionsBinding
  readonly runtimeSession: object
  readonly signal: AbortSignal
  readonly families: readonly NativeHeldMissionFamily[]
}

/** No automatic installation, quiescence, reload, discovery-root write or daemon
 * lifecycle. The native opening must supply genuine internal writer facts first.
 * This is not wired into backend startup or plugin management by this track. */
export class NativeMissionsHostFactory implements ProtectedNativeMissionHostFactory {
  private readonly families: readonly NativeHeldMissionFamily[]
  constructor(private readonly input: NativeMissionsHostInput) {
    NativeMissionsBinding.assert(input.binding)
    if (!input.families.length || input.families.length > NATIVE_MISSIONS_MAX_FAMILIES
      || new Set(input.families.map(item => item.held)).size !== input.families.length
      || new Set(input.families.map(item => item.held.family)).size !== input.families.length) refuse()
    this.families = Object.freeze(input.families.map(item => Object.freeze({ held: item.held, nativeClaim: item.nativeClaim })))
    this.input = Object.freeze({ ...input, families: this.families })
    factories.add(this)
    Object.freeze(this)
  }
  async open(): Promise<NativeManagedMissionsChannel> {
    if (!factories.has(this)) refuse()
    NativeMissionsBinding.assert(this.input.binding)
    const opening = await this.input.binding.open(this.input.runtimeSession, this.input.signal)
    try {
      const { sdk, handle } = opening.authority(this.input.binding)
      const channel = new NativeManagedMissionsChannel(opening, sdk, handle, this.families, this.input.signal, CHANNEL_MINT)
      channel.assertCurrent()
      return channel
    } catch (error) { opening.close(); throw error }
  }
}

/** Authority exists only while native-owned handles, registered writer,
 * authoritative inventory, signer and exact protected family tags stay current. */
export class NativeManagedMissionsChannel implements QualifiedNativeMissionChannel {
  readonly parent: QualifiedNativeMissionChannel["parent"]
  readonly bridge: QualifiedNativeMissionChannel["bridge"]
  readonly scope: QualifiedNativeMissionChannel["scope"]
  readonly #familyTags = new Map<HeldFamilyClaim, object>()
  private readonly abort = () => { try { this.close() } catch { /* Local authority is already closed; never publish after failed disposal. */ } }
  #closed = false
  constructor(private readonly opening: NativeMissionsOpening, private readonly sdk: NativeMissionsAuthoritySDK,
    private readonly handle: object, families: readonly NativeHeldMissionFamily[], private readonly signal: AbortSignal, mint: symbol) {
    if (mint !== CHANNEL_MINT) refuse()
    synchronous(() => sdk.missionsAssertChannel(handle))
    synchronous(() => sdk.missionsAssertQuiescence(handle))
    const record = invoke(() => sdk.readMissionsAuthority(handle))
    // Clone only the native projection; it is never accepted as a native proof.
    const immutable = JSON.parse(canonicalAuthority(record, NATIVE_MISSIONS_MAX_BYTES)) as typeof record
    if (immutable.physicalResolver !== "win32-local" || !localWindowsPath(immutable.privateRoot)
      || !localWindowsPath(immutable.scope.projectCanonical)) refuse()
    const descriptor = descriptorSchema.parse(immutable.descriptor)
    this.scope = Object.freeze(authorityBindingSchema.pick({ namespace: true, projectID: true, projectCanonical: true }).parse(immutable.scope))
    Object.freeze(descriptor.scope); Object.freeze(descriptor)
    for (const { held, nativeClaim } of families) {
      if (!localWindowsPath(held.family)) refuse()
      synchronous(() => sdk.assertMissionsFamily(handle, nativeClaim, held.family))
      this.#familyTags.set(held, nativeClaim)
    }
    this.parent = Object.freeze({ readStagingScope: () => {
      this.assertCurrent()
      return { privateRoot: immutable.privateRoot, descriptor }
    } })
    this.bridge = Object.freeze({
      readDiscoveryBoundary: async () => {
        this.assertCurrent()
        const result = await this.sdk.readMissionsDiscovery(this.handle)
        this.assertCurrent()
        return result
      },
      handshake: async (input: NativeMissionsHandshake) => {
        this.assertCurrent()
        const proof = bytes(await this.sdk.handshakeMissionsAuthority(this.handle, Buffer.from(canonicalAuthority(input, NATIVE_MISSIONS_MAX_BYTES))))
        this.assertCurrent()
        return proof
      },
      verify: (proof: unknown) => {
        this.assertCurrent()
        return invoke(() => this.sdk.verifyMissionsAuthority(this.handle, bytes(proof)))
      },
      assertCurrent: (proof: unknown, observationDigest: string): true => {
        this.assertCurrent()
        if (!/^[a-f0-9]{64}$/.test(observationDigest)) refuse()
        return synchronous(() => this.sdk.assertMissionsAuthority(this.handle, bytes(proof), observationDigest))
      },
    })
    channels.add(this)
    signal.addEventListener("abort", this.abort, { once: true })
    if (signal.aborted) { this.close(); refuse() }
    Object.freeze(this)
  }
  assertCurrent(): true {
    if (!channels.has(this) || this.#closed || this.signal.aborted) refuse()
    this.opening.assertCurrent()
    synchronous(() => this.sdk.missionsAssertQuiescence(this.handle))
    return synchronous(() => this.sdk.missionsAssertChannel(this.handle))
  }
  assertFamilyClaimCurrent(held: HeldFamilyClaim): true {
    this.assertCurrent()
    const tag = this.#familyTags.get(held)
    if (!tag) refuse()
    return synchronous(() => this.sdk.assertMissionsFamily(this.handle, tag, held.family))
  }
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.signal.removeEventListener("abort", this.abort)
    this.#familyTags.clear()
    this.opening.close()
  }

  /** The originating authenticated HTTP operation owns the entire native lease
   * interval. Only opaque invocation ID/digest correlation crosses the private
   * writer channel; HTTP cookies and the root JS closure never leave B.
   * The operation MUST capture via the runtime producer before its first await. */
  async withHumanInvocation<T>(input: { signedDigest: string; signal: AbortSignal; assertOriginCurrent(): true },
    operation: (invocation: Readonly<{ invocationID: string; signedDigest: string }>) => Promise<T>): Promise<T> {
    this.assertCurrent()
    return runNativeOriginInvocation({ ...input, channelSignal: this.signal, assertChannelCurrent: () => this.assertCurrent() }, {
      admit: invocation => this.sdk.admitMissionsHuman(this.handle, invocation),
      revoke: invocationID => this.sdk.revokeMissionsHuman(this.handle, invocationID),
      assertCurrent: lease => this.sdk.assertMissionsHuman(this.handle, lease),
      invalidateChannel: () => this.close(),
    }, operation)
  }

  /** Publication is a hard-wired runtime-owned atomic transaction ABI, NOT an
   * arbitrary JS callback wrapped in a guard. Current ctx.storage.set is async
   * and has no such producer, so it must never be routed through this method. */
  publish(lease: object, publication: Buffer): Buffer {
    this.assertCurrent()
    const payload = bytes(publication), digest = createHash("sha256").update(payload).digest("hex")
    synchronous(() => this.sdk.assertMissionsHuman(this.handle, lease))
    const guard = invoke(() => this.sdk.acquireMissionsCommit(this.handle, lease, digest))
    try { return bytes(invoke(() => this.sdk.publishMissionsCommit(this.handle, guard, payload))) }
    finally { synchronous(() => this.sdk.releaseMissionsCommit(this.handle, guard)) }
  }
}
