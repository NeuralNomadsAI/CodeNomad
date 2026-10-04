import { randomBytes } from "node:crypto"
import { HostError } from "./protocol"
import { NativeRuntimeBinding } from "./native-runtime-binding"
import { NativeDeadline } from "./native-deadline"
import { MISSIONS_CHANNEL_METHODS, MISSIONS_AUTHORITY_METHODS, NATIVE_MISSIONS_PROTOCOL, NATIVE_MISSIONS_AUTHORITY_PROTOCOL,
  type NativeMissionsSDK, type NativeMissionsAuthoritySDK } from "./native-missions-contract"

const bindings = new WeakSet<NativeMissionsBinding>()
const bindingSDK = new WeakMap<NativeMissionsBinding, NativeMissionsSDK>()
const OPENING_MINT = Symbol("native-missions-opening")

/** Only the actual compiled addon loader can create this binding. There is no
 * SDK-object constructor, proof parser, env option or private fixture mint.
 * A matching channel protocol is necessary but never writer qualification. */
export class NativeMissionsBinding {
  private constructor(private readonly sdk: NativeMissionsSDK) {
    bindings.add(this); bindingSDK.set(this, sdk); Object.freeze(this)
  }
  static fromRuntimeBinding(runtime: NativeRuntimeBinding): NativeMissionsBinding {
    NativeRuntimeBinding.assert(runtime)
    const sdk = runtime.sdk as unknown as NativeMissionsSDK
    if (Object.prototype.hasOwnProperty.call(sdk, "fixtureAuthorizeNestedResponse"))
      throw new HostError("native-missions-fixture-binding-refused")
    if (sdk.missionsProtocol !== NATIVE_MISSIONS_PROTOCOL
      || MISSIONS_CHANNEL_METHODS.some(method => typeof sdk[method] !== "function"))
      throw new HostError("native-missions-artifact-incompatible")
    return new NativeMissionsBinding(sdk)
  }
  static async load(trustedFile: string, trustedSha256: string): Promise<NativeMissionsBinding> {
    return this.fromRuntimeBinding(await NativeRuntimeBinding.load(trustedFile, trustedSha256))
  }
  static assert(binding: NativeMissionsBinding): void {
    if (!bindings.has(binding)) throw new HostError("native-missions-binding-required")
  }
  async open(runtimeSession: object, signal: AbortSignal): Promise<NativeMissionsOpening> {
    NativeMissionsBinding.assert(this)
    signal.throwIfAborted()
    let lost = false
    const budget = new NativeDeadline(5_000, undefined, () => { lost = true })
    const opening = this.sdk.openMissionsChannel(runtimeSession, randomBytes(32))
    const abort = () => { lost = true }
    signal.addEventListener("abort", abort, { once: true })
    try {
      const native = await budget.observe(() => opening.then(handle => {
        if (lost || signal.aborted) { this.sdk.missionsRelease(handle); throw new HostError("native-missions-open-cancelled") }
        return handle
      }))
      try {
        signal.throwIfAborted()
        budget.check()
        // This invokes the compiled native tag/retained identity check. A
        // Promise returning JSON or a live-process receipt cannot pass it.
        if (this.sdk.missionsAssertChannel(native) !== undefined) throw new HostError("native-missions-synchronous-guard-required")
        signal.throwIfAborted(); budget.check()
        return new NativeMissionsOpening(this, this.sdk, native, OPENING_MINT)
      } catch (error) { this.sdk.missionsRelease(native); throw error }
    } finally { signal.removeEventListener("abort", abort) }
  }
}

const openings = new WeakMap<NativeMissionsOpening, NativeMissionsBinding>()
/** Internal native opening; deliberately does not implement QualifiedNativeMissionChannel. */
export class NativeMissionsOpening {
  #closed = false
  constructor(binding: NativeMissionsBinding, private readonly sdk: NativeMissionsSDK,
    private readonly handle: object, mint: symbol) {
    if (mint !== OPENING_MINT || bindingSDK.get(binding) !== sdk) throw new HostError("native-missions-channel-required")
    openings.set(this, binding)
    Object.freeze(this)
  }
  assertCurrent(): void {
    if (!openings.has(this) || this.#closed) throw new HostError("native-missions-channel-closed")
    if (this.sdk.missionsAssertChannel(this.handle) !== undefined) throw new HostError("native-missions-synchronous-guard-required")
  }
  authority(binding: NativeMissionsBinding): { sdk: NativeMissionsAuthoritySDK; handle: object } {
    NativeMissionsBinding.assert(binding)
    if (openings.get(this) !== binding) throw new HostError("native-missions-channel-required")
    this.assertCurrent()
    if ((this.sdk as NativeMissionsAuthoritySDK).missionsAuthorityProtocol !== NATIVE_MISSIONS_AUTHORITY_PROTOCOL
      || MISSIONS_AUTHORITY_METHODS.some(method => typeof (this.sdk as unknown as Record<string, unknown>)[method] !== "function"))
      throw new HostError("native-missions-runtime-producer-unavailable")
    return { sdk: this.sdk as NativeMissionsAuthoritySDK, handle: this.handle }
  }
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.sdk.missionsRelease(this.handle)
  }
}
