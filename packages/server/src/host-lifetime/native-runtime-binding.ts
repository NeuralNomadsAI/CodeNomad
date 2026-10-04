import { Module } from "node:module"
import { createHash } from "node:crypto"
import { lstat, readFile, realpath } from "node:fs/promises"
import path from "node:path"
import type { Duplex } from "node:stream"
import type { Scope } from "./protocol"
import { HostError } from "./protocol"

export interface NativeBirth { pid: number; filetime: string }
export interface NativeManagerFacts {
  nonce: string; generation: string; scope: Scope; runtimeId: string
  manager: NativeBirth; supervisor: NativeBirth; alive: true
  assignedSuspended: true; supervisorOutsideAllJobs: true; ownerBootstrapVerified: true
  soleJobOwnerPid: number; jobHandleInherited: false; limitFlags: number
  servicePeer: NativeBirth & { outsideAllJobs: true; policyScope: string; launcher: "native-service-launcher-v1" }
}
export interface NativeMemberFacts { nonce: string; runtimeId: string; member: NativeBirth; alive: true; inherited: true }
export interface NativeServiceFacts {
  requestDigest: string; runtimeId: string; peer: NativeBirth; starter: NativeBirth
  outsideAllJobsBeforeResume: true; policyScope: string; originalExecutionPreserved: true
}
/** ABI implemented by the trusted compiled binding, NOT a JSON attestation
 * reader. All verify methods must invoke RuntimeSession/retained native handles,
 * native private-peer/CNG validation and fresh process/Job queries themselves.
 * PID arguments are candidate locators only. No assignment/exec API is exposed. */
export interface NativeRuntimeSDK {
  abi: "codenomad.runtime.v1"
  openManager(challenge: Buffer): Promise<{ channel: Duplex; nativeSession: object; key: Buffer; launch: Buffer; attestation: Buffer }>
  verifyManager(session: object, challenge: Buffer, launchDigest: string, attestation: Buffer): Promise<NativeManagerFacts>
  verifyMember(session: object, candidatePid: number, challenge: Buffer, attestation: Buffer): Promise<NativeMemberFacts>
  authorizeService(session: object, request: Buffer, deadline: number): Promise<Buffer>
  verifyService(session: object, digest: string, attestation: Buffer): Promise<NativeServiceFacts>
  release(session: object): void
}
const production = new WeakSet<NativeRuntimeBinding>()
const known = new WeakSet<NativeRuntimeBinding>()
// Capture the actual native loader at module initialization. Neither cached JS
// exports nor require.extensions may certify a hash-checked .node artifact.
// Arbitrary mutation of trusted builtins before this module loads is outside
// this in-process boundary; no global cache/hook is deleted or overwritten here.
const loadNative = process.dlopen.bind(process)
const methods = ["openManager", "verifyManager", "verifyMember", "authorizeService", "verifyService", "release"] as const
export class NativeRuntimeBinding {
  private constructor(readonly sdk: NativeRuntimeSDK) { known.add(this); Object.freeze(sdk); Object.freeze(this) }
  static async load(file: string, expectedSha256: string): Promise<NativeRuntimeBinding> {
    // Paths/digests come from trusted packaged host code, never renderer, argv,
    // profile settings or environment. Only a verified native addon can mint a
    // production binding; a JS callback/object cannot pass this loader.
    if (!path.isAbsolute(file) || path.extname(file) !== ".node" || !/^[a-f0-9]{64}$/.test(expectedSha256))
      throw new HostError("native-runtime-binding-required")
    try {
      const stat = await lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || path.resolve(await realpath(file)) !== path.resolve(file))
        throw new Error()
      if (createHash("sha256").update(await readFile(file)).digest("hex") !== expectedSha256) throw new Error()
      const nativeModule = new Module(file)
      nativeModule.filename = file
      loadNative(nativeModule, file)
      const sdk = nativeModule.exports as NativeRuntimeSDK
      if (sdk.abi !== "codenomad.runtime.v1" || methods.some(method => typeof sdk[method] !== "function")) throw new Error()
      const binding = new NativeRuntimeBinding(sdk)
      production.add(binding)
      return binding
    } catch { throw new HostError("native-runtime-binding-unverified") }
  }
  static assert(binding: NativeRuntimeBinding, allowFixture = false): void {
    if (!known.has(binding) || (!allowFixture && !production.has(binding))) throw new HostError("native-runtime-binding-unverified")
  }
  get production(): boolean { return production.has(this) }
  /** @internal Explicit SDK-stub construction for private tests. It can NEVER
   * construct a production capability or qualify Job/privacy/independence. */
  static forPrivateFixture(sdk: NativeRuntimeSDK): NativeRuntimeBinding {
    if (sdk.abi !== "codenomad.runtime.v1" || methods.some(method => typeof sdk[method] !== "function"))
      throw new HostError("invalid-fixture-native-sdk")
    return new NativeRuntimeBinding(sdk)
  }
}
