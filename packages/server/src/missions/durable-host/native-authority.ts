import { randomBytes } from "node:crypto"
import { z } from "zod"
import type { WorkspaceManager } from "../../workspaces/manager"
import { CODENOMAD_MISSIONS_AUTHORITY_RPC } from "../authority-rpc"
import { CODENOMAD_MISSIONS_RPC } from "../rpc"
import type { MissionSnapshot } from "../model"
import type { NativeAuthorityMirrorReader, NativeMirrorObservation } from "../host-authority/registry"
import { authorityGrantSchema } from "../authority-store"
import { authorityReceiptReadSchema } from "../authority-receipt"
import type { AuthorityOperationResult } from "../authority-core"
import { authorityDigest, authorityEffectResultSchema, canonicalAuthority, matchesObservedLifecycle, rejectAuthority, MISSION_AUTHORITY_POLICY, type AuthorityBinding, type AuthorityIntent, type AuthorityRoot, type SignedAuthorityIntent } from "../authority-protocol"
import { assertSynchronousAuthorityGuard } from "../authority-synchronous"
import type { CanonicalMissionRoots } from "./roots"
import type { HumanIntentLeases } from "./human-intents"

type Manager = Pick<WorkspaceManager, "getSharedServiceConnection" | "ownsLocation">
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
    if (!connection) rejectAuthority("observation-unavailable")
    const session = await connection.client.session.get({ sessionID: binding.coordinatorSessionID }, { signal })
    if (session.parentID || session.projectID !== binding.projectID
      || !await this.input.manager.ownsLocation(this.input.workspaceID, session.location, connection.client)
      || !binding.roots.some(root => root.directory === session.location.directory)) rejectAuthority("binding-mismatch")
    await this.input.roots.assertRoots(binding.roots)
    const fresh = await connection.client.session.get({ sessionID: binding.coordinatorSessionID }, { signal })
    if (fresh.id !== session.id || fresh.parentID || fresh.projectID !== session.projectID
      || fresh.location.directory !== session.location.directory
      || !await this.input.manager.ownsLocation(this.input.workspaceID, fresh.location, connection.client)) rejectAuthority("binding-mismatch")
    const current = () => { signal.throwIfAborted(); connection.assertCurrent(); assertSynchronousAuthorityGuard(this.input.assertNativeCurrent, "policy-unqualified") }
    current()
    return { connection, options: { location: { directory: session.location.directory }, signal }, current }
  }
  async challenge(binding: AuthorityBinding, signal: AbortSignal) {
    const { connection, options, current } = await this.target(binding, signal)
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
    const snapshot = await connection.client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, options) as MissionSnapshot
    const mission = snapshot.missions.find(item => item.id === body.missionID)
    if (mission) {
      if (mission.coordinatorSessionId !== body.coordinatorSessionID || mission.projectID !== body.projectID
        || mission.projectCanonical !== body.projectCanonical) rejectAuthority("binding-mismatch")
      const roots = new Map<string, AuthorityRoot>()
      for (const actor of mission.actors) {
        const session = await connection.client.session.get({ sessionID: actor.sessionId }, { signal })
        if (session.parentID || session.projectID !== body.projectID || session.location.directory !== actor.location.directory) rejectAuthority("binding-mismatch")
        const root = await this.input.roots.resolve(session.location)
        roots.set(root.directory, root)
      }
      const ordered = (items: AuthorityRoot[]) => items.sort((a, b) => a.directory < b.directory ? -1 : a.directory > b.directory ? 1 : 0)
      if (canonicalAuthority(ordered([...roots.values()])) !== canonicalAuthority(ordered([...body.roots]))) rejectAuthority("binding-mismatch")
    }
    const second = await readReceipt()
    const after = stateSchema.parse(await rpc.state({ missionID: body.missionID }, options))
    const freshSnapshot = await connection.client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, options) as MissionSnapshot
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
