import { randomBytes } from "node:crypto"
import { z } from "zod"
import type { WorkspaceManager } from "../../workspaces/manager"
import { CODENOMAD_MISSIONS_AUTHORITY_RPC } from "../authority-rpc"
import { CODENOMAD_MISSIONS_RPC } from "../rpc"
import type { MissionSnapshot } from "../model"
import type { NativeAuthorityMirrorReader, NativeMirrorObservation, NativeGrantObservation } from "../host-authority/registry"
import { authorityGrantSchema, type AuthorityGrant } from "../authority-store"
import { authorityReceiptReadSchema } from "../authority-receipt"
import type { AuthorityOperationResult } from "../authority-core"
import { authorityDigest, authorityEffectResultSchema, canonicalAuthority, matchesObservedLifecycle, rejectAuthority, MISSION_AUTHORITY_POLICY, type AuthorityBinding, type AuthorityIntent, type AuthorityRoot, type SignedAuthorityIntent } from "../authority-protocol"
import { assertSynchronousAuthorityGuard } from "../authority-synchronous"
import type { CanonicalMissionRoots } from "./roots"
import type { HumanIntentLeases } from "./human-intents"
import { readAuthoritySnapshot } from "./authority-snapshot"
import type { ServiceConnection } from "../../workspaces/opencode-service"
import type { MissionLocation } from "../model"

type Manager = Pick<WorkspaceManager, "getSharedServiceConnection" | "getExistingSharedServiceConnection" | "ownsLocation">
const stateSchema = z.object({ continuity: z.enum(["needs-authorization", "active", "revoked"]), grant: authorityGrantSchema.nullable(),
  terminal: z.enum(["stopped", "deleted"]).nullable(), pendingRequestIDs: z.array(z.string()).max(20_000) }).strict()
const challengeSchema = z.object({ nonce: z.string(), namespace: z.string().uuid(), policy: z.literal(MISSION_AUTHORITY_POLICY),
  projectID: z.string(), projectCanonical: z.string() }).strict()
export class CanonicalNativeAuthority implements NativeAuthorityMirrorReader {
  constructor(private readonly input: { manager: Manager; workspaceID: string; roots: CanonicalMissionRoots;
    assertNativeCurrent(): true; humanIntents: HumanIntentLeases }) {}
  private async target(binding: AuthorityBinding, signal: AbortSignal) {
    signal.throwIfAborted()
    const connection = await this.input.manager.getSharedServiceConnection(this.input.workspaceID)
    return this.targetConnection(binding, signal, connection, () => this.input.roots.assertRoots(binding.roots), "request")
  }
  private targetExisting(binding: AuthorityBinding, signal: AbortSignal) {
    signal.throwIfAborted()
    return this.targetConnection(binding, signal, this.input.manager.getExistingSharedServiceConnection(this.input.workspaceID),
      () => this.input.roots.assertExistingRoots(binding.roots, signal), "event")
  }
  private async targetConnection(binding: AuthorityBinding, signal: AbortSignal, connection: ServiceConnection | undefined,
    checkRoots: () => Promise<void>, purpose: "request" | "event") {
    if (!connection) rejectAuthority("observation-unavailable")
    const session = await connection.client.session.get({ sessionID: binding.coordinatorSessionID }, { signal })
    if (session.id !== binding.coordinatorSessionID || session.parentID || session.projectID !== binding.projectID
      || !await this.input.manager.ownsLocation(this.input.workspaceID, session.location, connection.client, signal, purpose)
      || !binding.roots.some(root => root.directory === session.location.directory)) rejectAuthority("binding-mismatch")
    await checkRoots()
    const fresh = await connection.client.session.get({ sessionID: binding.coordinatorSessionID }, { signal })
    if (fresh.id !== session.id || fresh.parentID || fresh.projectID !== session.projectID
      || fresh.location.directory !== session.location.directory
      || !await this.input.manager.ownsLocation(this.input.workspaceID, fresh.location, connection.client, signal, purpose)) rejectAuthority("binding-mismatch")
    const current = () => { signal.throwIfAborted(); connection.assertCurrent(); assertSynchronousAuthorityGuard(this.input.assertNativeCurrent, "policy-unqualified") }
    current()
    return { connection, options: { location: { directory: session.location.directory }, signal }, current }
  }
  async challenge(binding: AuthorityBinding, signal: AbortSignal) {
    return this.challengeTarget(binding, await this.target(binding, signal))
  }
  private async challengeExisting(binding: AuthorityBinding, signal: AbortSignal) {
    return this.challengeTarget(binding, await this.targetExisting(binding, signal))
  }
  private async challengeTarget(binding: AuthorityBinding, target: Awaited<ReturnType<CanonicalNativeAuthority["target"]>>) {
    const { connection, options, current } = target
    const nonce = randomBytes(24).toString("base64url")
    const result = challengeSchema.parse(await connection.client.rpc(CODENOMAD_MISSIONS_AUTHORITY_RPC).challenge({ nonce }, options))
    current()
    if (result.nonce !== nonce || result.namespace !== binding.namespace || result.projectID !== binding.projectID
      || result.projectCanonical !== binding.projectCanonical) rejectAuthority("namespace-mismatch")
    return result
  }
  async execute(signed: SignedAuthorityIntent, signal: AbortSignal, assertAuthorityCurrent: () => true): Promise<AuthorityOperationResult> {
    return this.input.humanIntents.run(signed, signal, assertAuthorityCurrent, async () => {
      await this.challenge(signed.body, signal)
      assertSynchronousAuthorityGuard(assertAuthorityCurrent, "policy-unqualified")
      const { connection, options, current } = await this.target(signed.body, signal)
      current()
      assertSynchronousAuthorityGuard(assertAuthorityCurrent, "policy-unqualified")
      this.input.roots.current(signed.body.roots)
      const result = await connection.client.rpc(CODENOMAD_MISSIONS_AUTHORITY_RPC).intent(signed, options) as AuthorityOperationResult
      current()
      assertSynchronousAuthorityGuard(assertAuthorityCurrent, "policy-unqualified")
      return result
    })
    // No success inference on disconnect, no retry and no completion fallback.
  }
  private async assertActors(binding: AuthorityBinding, mission: MissionSnapshot["missions"][number], connection: ServiceConnection | undefined,
    signal: AbortSignal, resolveRoot: (location: MissionLocation) => Promise<AuthorityRoot> = location => this.input.roots.resolve(location)) {
    if (!connection || mission.coordinatorSessionId !== binding.coordinatorSessionID || mission.projectID !== binding.projectID
      || mission.projectCanonical !== binding.projectCanonical) rejectAuthority("binding-mismatch")
    const roots = new Map<string, AuthorityRoot>()
    for (const actor of mission.actors) {
      const session = await connection.client.session.get({ sessionID: actor.sessionId }, { signal })
      if (session.id !== actor.sessionId || session.parentID || session.projectID !== binding.projectID
        || session.location.directory !== actor.location.directory) rejectAuthority("binding-mismatch")
      const root = await resolveRoot(session.location)
      roots.set(root.directory, root)
    }
    const ordered = (items: AuthorityRoot[]) => items.sort((a, b) => a.directory < b.directory ? -1 : a.directory > b.directory ? 1 : 0)
    if (canonicalAuthority(ordered([...roots.values()])) !== canonicalAuthority(ordered([...binding.roots]))) rejectAuthority("binding-mismatch")
  }
  async restore(grant: AuthorityGrant, signal: AbortSignal): Promise<NativeGrantObservation> {
    await this.challengeExisting(grant, signal)
    const { connection, options, current } = await this.targetExisting(grant, signal)
    const read = async (): Promise<NativeGrantObservation> => {
      const state = stateSchema.parse(await connection.client.rpc(CODENOMAD_MISSIONS_AUTHORITY_RPC).state({ missionID: grant.missionID }, options))
      const snapshot = readAuthoritySnapshot(await connection.client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, options))
      current()
      const mission = snapshot.missions.find(item => item.id === grant.missionID)
      if (!mission || snapshot.projectID !== grant.projectID || snapshot.controlUnavailable || mission.controlUnavailable
        || state.continuity !== "active" || canonicalAuthority(state.grant) !== canonicalAuthority(grant)) rejectAuthority("authorization-blocked")
      if (!mission.control || mission.control.action !== "start" || !mission.control.completedRevision
        || mission.control.pending.length) rejectAuthority("authorization-blocked")
      await this.assertActors(grant, mission, connection, signal, location => this.input.roots.resolveExisting(location, signal))
      current()
      return { grant: state.grant, revision: mission.revision, terminal: state.terminal, pendingRequestIDs: state.pendingRequestIDs,
        status: mission.status, runState: mission.runState ?? "prepared", controlPending: false,
        control: { id: mission.control.id, missionID: mission.control.missionID, requestID: mission.control.requestID,
          action: mission.control.action, expectedRevision: mission.control.expectedRevision, completedRevision: mission.control.completedRevision,
          targets: structuredClone(mission.control.targets), pending: [] } }
    }
    const first = await read(), second = await read()
    await this.challengeExisting(grant, signal)
    await this.input.roots.assertExistingRoots(grant.roots, signal)
    current()
    if (canonicalAuthority(first) !== canonicalAuthority(second)) rejectAuthority("observation-unavailable")
    return second
  }
  async read(body: AuthorityIntent): Promise<NativeMirrorObservation> {
    const signal = AbortSignal.timeout(15_000)
    await this.challenge(body, signal)
    const { connection, options, current } = await this.target(body, signal)
    const rpc = connection.client.rpc(CODENOMAD_MISSIONS_AUTHORITY_RPC)
    const readReceipt = async () => {
      const response = await rpc.receipt({ intent: body, digest: authorityDigest(body) }, options)
      current()
      canonicalAuthority(response, 2 * 1024 * 1024)
      const result = authorityReceiptReadSchema.parse(response)
      if (result.namespace !== body.namespace || result.projectID !== body.projectID || result.projectCanonical !== body.projectCanonical) rejectAuthority("binding-mismatch")
      return result.receipt
    }
    const before = stateSchema.parse(await rpc.state({ missionID: body.missionID }, options))
    const first = await readReceipt()
    const snapshot = readAuthoritySnapshot(await connection.client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, options))
    const mission = snapshot.missions.find(item => item.id === body.missionID)
    if (mission) await this.assertActors(body, mission, connection, signal)
    const second = await readReceipt()
    const after = stateSchema.parse(await rpc.state({ missionID: body.missionID }, options))
    const freshSnapshot = readAuthoritySnapshot(await connection.client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, options))
    const freshMission = freshSnapshot.missions.find(item => item.id === body.missionID)
    const projection = (item: typeof mission) => item ? { id: item.id, revision: item.revision, coordinator: item.coordinatorSessionId,
      projectID: item.projectID, projectCanonical: item.projectCanonical, status: item.status, runState: item.runState ?? "prepared", actors: item.actors,
      ...(item.control ? { control: item.control } : {}),
      ...(item.controlUnavailable !== undefined ? { controlUnavailable: item.controlUnavailable } : {}) } : null
    await this.challenge(body, signal)
    await this.input.roots.assertRoots(body.roots)
    current()
    if (!first || !second || authorityDigest(first) !== authorityDigest(second)
      || authorityDigest(first.intent) !== authorityDigest(body) || canonicalAuthority(before) !== canonicalAuthority(after)
      || snapshot.projectID !== body.projectID || freshSnapshot.projectID !== body.projectID
      || snapshot.controlUnavailable !== freshSnapshot.controlUnavailable
      || canonicalAuthority(projection(mission)) !== canonicalAuthority(projection(freshMission))) rejectAuthority("observation-unavailable")
    if (body.method === "lifecycle" && second.completion?.outcome === "applied"
      && (!mission || snapshot.controlUnavailable || !matchesObservedLifecycle(body, second.completion.result, mission))) rejectAuthority("observation-unavailable")
    const result = !mission && second.completion?.result && body.method !== "adopt" && body.method !== "revoke"
      ? authorityEffectResultSchema.parse(second.completion.result) : undefined
    const revision = mission?.revision ?? (result && result.revision)
    if (revision === undefined) {
      // Delete may remove the journal map. Only its exact completed native
      // receipt+terminal permits settlement at the original revision.
      if (body.method !== "delete" || after.terminal !== "deleted" || !second.completion) rejectAuthority("observation-unavailable")
    }
    return { operation: { receipt: second, grant: after.grant }, revision: revision ?? body.expectedRevision,
      terminal: after.terminal, pendingRequestIDs: after.pendingRequestIDs }
  }
}
