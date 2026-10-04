import type { AuthManager } from "../../auth/manager"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import type { DurableMissionsHost } from "../../opencode/missions/durable-plugin"
import { type HostAuthorityParent, type PrivateManagedAuthorityBridge } from "../host-authority/index"
import { ProtectedAuthorityFiles } from "../host-authority/private-files"
import { ProtectedHostAuthority } from "../host-authority/store"
import { HostAuthorityAdmissions } from "../host-authority/qualification"
import { assertSynchronousAuthorityGuard } from "../authority-synchronous"
import { authorityBindingSchema, rejectAuthority, type AuthorityBinding } from "../authority-protocol"
import { CanonicalMissionRoots, type HeldFamilyClaim } from "./roots"
import { canonicalAuthorityOwnership } from "./ownership"
import { CanonicalNativeAuthority } from "./native-authority"
import { createCanonicalMissionTransport, type AdmissionManager } from "./transport"
import { createMissionAuthorityActions } from "../../server/routes/mission-authority-actions"
import { HumanIntentLeases } from "./human-intents"

/** Exact native-parent handoff, NOT a caller JSON proof/boolean. The independent
 * runtime-session/host-lifetime owner must return an authenticated sustained
 * private channel. No production implementation is invented here. */
export interface QualifiedNativeMissionChannel {
  parent: HostAuthorityParent
  bridge: PrivateManagedAuthorityBridge
  scope: Pick<AuthorityBinding, "namespace" | "projectID" | "projectCanonical">
  assertCurrent(): true
  assertFamilyClaimCurrent(claim: HeldFamilyClaim): true
}
export interface ProtectedNativeMissionHostFactory {
  open(): Promise<QualifiedNativeMissionChannel>
}
type Manager = AdmissionManager & Pick<WorkspaceManager, "getHostPathForServicePath">
export interface CanonicalDurableHostDependencies {
  nativeHost: ProtectedNativeMissionHostFactory; auth: AuthManager; manager: Manager; workspaceID: string
  fence: WorktreeDeletionFence; familyClaims: readonly HeldFamilyClaim[]
}

/** Executable composition, still intentionally NOT imported by backend startup
 * or desktop plugin management. There is no permissive qualification option.
 * Construction fails until the genuine native private channel is available. */
export async function createCanonicalDurableMissionsHost(input: CanonicalDurableHostDependencies) {
  let channel: QualifiedNativeMissionChannel
  try { channel = await input.nativeHost.open() } catch { rejectAuthority("trust-unavailable") }
  assertSynchronousAuthorityGuard(() => channel.assertCurrent(), "policy-unqualified")
  const staging = channel.parent.readStagingScope()
  const { host, authority, actions } = assembleCanonicalDurableMissionsHost(input, channel, new ProtectedAuthorityFiles(staging.privateRoot, staging.descriptor))
  return Object.freeze({ host, authority, actions })
}

/** Internal composition seam for isolated FILE-policy fixtures. Production uses
 * only createCanonicalDurableMissionsHost above (no policy/signer override).
 * This does not issue or verify a native attestation. Never wire it to HTTP. */
export function assembleCanonicalDurableMissionsHost(input: CanonicalDurableHostDependencies,
  channel: QualifiedNativeMissionChannel, files: ProtectedAuthorityFiles) {
  const scope = authorityBindingSchema.pick({ namespace: true, projectID: true, projectCanonical: true }).parse(channel.scope)
  const assertNativeCurrent = (): true => assertSynchronousAuthorityGuard(() => channel.assertCurrent(), "policy-unqualified")
  assertNativeCurrent()
  const roots = new CanonicalMissionRoots(input.manager, input.workspaceID, input.familyClaims, claim => {
    assertNativeCurrent()
    return assertSynchronousAuthorityGuard(() => channel.assertFamilyClaimCurrent(claim), "policy-unqualified")
  })
  const humanIntents = new HumanIntentLeases()
  const native = new CanonicalNativeAuthority({ manager: input.manager, workspaceID: input.workspaceID, roots, assertNativeCurrent, humanIntents })
  const authority = new ProtectedHostAuthority(files, new HostAuthorityAdmissions(input.auth,
    canonicalAuthorityOwnership({ ...input, roots, assertNativeCurrent }), files.descriptor, channel.bridge), native)
  const host: DurableMissionsHost = {
    captureHumanIntent: signed => humanIntents.capture(signed),
    assertManagedIncarnation: assertNativeCurrent,
    readSigners: async () => { assertNativeCurrent(); const signers = await authority.readSigners(); assertNativeCurrent(); return signers },
    assertSignerCurrent: signer => { assertNativeCurrent(); return authority.assertSignerCurrent(signer) },
    resolveRoot: location => roots.resolve(location),
    transport: createCanonicalMissionTransport({ ...input, authority, roots, assertNativeCurrent }),
  }
  const actions = createMissionAuthorityActions({ ...input, authority, native, roots, scope, assertNativeCurrent })
  assertNativeCurrent()
  return Object.freeze({ host: Object.freeze(host), authority, actions, native, roots })
}
