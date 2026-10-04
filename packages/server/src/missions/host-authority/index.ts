import type { AuthManager } from "../../auth/manager"
import type { HostAuthorityDescriptor } from "./model"
import { ProtectedAuthorityFiles } from "./private-files"
import { HostAuthorityAdmissions, type OwnedAuthorityMutationGate, type PrivateManagedAuthorityBridge } from "./qualification"
import type { NativeAuthorityMirrorReader } from "./registry"
import { ProtectedHostAuthority } from "./store"

/** Trusted persistent parent's PRIVATE construction channel, not a serialized
 * HTTP/bootstrap/config object. This staging descriptor cannot qualify execution;
 * every signature additionally requires the private native attestation bridge.
 * No implementation/attestation issuer is synthesized in this module. */
export interface HostAuthorityParent {
  readStagingScope(): { privateRoot: string; descriptor: HostAuthorityDescriptor }
}
export function createProtectedHostAuthority(input: {
  parent: HostAuthorityParent
  auth: AuthManager
  ownership: OwnedAuthorityMutationGate
  bridge?: PrivateManagedAuthorityBridge
  nativeMirror?: NativeAuthorityMirrorReader
}): ProtectedHostAuthority {
  const { privateRoot, descriptor } = input.parent.readStagingScope()
  // Production path has NO permissive policy/signer/key/qualification override.
  return new ProtectedHostAuthority(new ProtectedAuthorityFiles(privateRoot, descriptor),
    new HostAuthorityAdmissions(input.auth, input.ownership, descriptor, input.bridge), input.nativeMirror)
}
export type { HostAuthorityDescriptor } from "./model"
export type { HostAuthoritySnapshot, HostAuthorityTarget } from "./store"
export type { PrivateManagedAuthorityBridge, ManagedAuthorityObservation, OwnedAuthorityMutationGate } from "./qualification"
export type { HostAuthorityRegistry, NativeAuthorityMirrorReader, NativeMirrorObservation } from "./registry"
export { readNativeDiscoveryBoundary } from "./quiescence"
