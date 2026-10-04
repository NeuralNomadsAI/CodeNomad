import type { FastifyRequest } from "fastify"
import type { AuthManager } from "../../auth/manager"
import { z } from "zod"
import { stableToken } from "../../missions/journal"
import { authorityDigest, canonicalAuthority, authorityIntentSchema, MISSION_AUTHORITY_POLICY, rejectAuthority, type AuthorityBinding } from "../../missions/authority-protocol"
import type { ProtectedHostAuthority } from "../../missions/host-authority/store"
import type { CanonicalNativeAuthority } from "../../missions/durable-host/native-authority"
import type { CanonicalMissionRoots } from "../../missions/durable-host/roots"
import type { WorkspaceManager } from "../../workspaces/manager"
import { assertSynchronousAuthorityGuard } from "../../missions/authority-synchronous"

const requestID = z.string().min(1).max(128)
const common = z.object({ requestID, expectedRevision: z.number().int().nonnegative().safe(), expectedHostRevision: z.number().int().positive().safe() })
const pickPayload = (method: string) => authorityIntentSchema.options.find(schema => schema.shape.method.value === method)!.shape.payload
export const missionHumanActionSchema = z.discriminatedUnion("method", [
  common.extend({ method: z.literal("update"), payload: pickPayload("update") }).strict(),
  common.extend({ method: z.literal("lifecycle"), payload: pickPayload("lifecycle") }).strict(),
  common.extend({ method: z.literal("recover"), payload: pickPayload("recover") }).strict(),
  common.extend({ method: z.literal("delete"), payload: z.object({ deleteManagedSessions: z.literal(false) }).strict() }).strict(),
  common.extend({ method: z.literal("adopt"), payload: z.object({}).strict() }).strict(),
  common.extend({ method: z.literal("revoke"), payload: z.object({}).strict() }).strict(),
])
const createSchema = z.object({ requestID, coordinatorSessionId: z.string().regex(/^ses_/).max(240),
  payload: pickPayload("create") }).strict()
type Manager = Pick<WorkspaceManager, "getSharedServiceConnection" | "ownsLocation">

/** Existing router wiring helper, NOT a new HTTP surface or generic RPC proxy.
 * Normal AuthManager middleware remains mandatory. The helper additionally
 * fences that SAME cookie session after signing/RPC preparation. No browser
 * supplied grant/key/namespace/epoch/roots/transport command is accepted. */
export function createMissionAuthorityActions(input: {
  auth: AuthManager; authority: ProtectedHostAuthority; native: CanonicalNativeAuthority; roots: CanonicalMissionRoots
  manager: Manager; workspaceID: string; scope: Pick<AuthorityBinding, "namespace" | "projectID" | "projectCanonical">
  assertNativeCurrent(): true
}) {
  const human = (request: FastifyRequest, signal: AbortSignal) => {
    signal.throwIfAborted()
    const session = input.auth.getSessionFromRequest(request)
    if (!input.auth.isAuthEnabled() || !session || session.sessionId === "auth-disabled") rejectAuthority("authorization-blocked")
    return (): true => {
      signal.throwIfAborted()
      const fresh = input.auth.getSessionFromRequest(request)
      if (!input.auth.isAuthEnabled() || !fresh || fresh.sessionId !== session.sessionId || fresh.username !== session.username) rejectAuthority("authorization-blocked")
      return assertSynchronousAuthorityGuard(input.assertNativeCurrent, "policy-unqualified")
    }
  }
  const execute = async (request: FastifyRequest, raw: unknown, signal: AbortSignal) => {
    canonicalAuthority(raw)
    const current = human(request, signal), action = missionHumanActionSchema.parse(raw)
    const state = await input.authority.read()
    current()
    if (!state) rejectAuthority("authorization-blocked")
    const body = authorityIntentSchema.parse({ ...state.binding, version: 1, policy: MISSION_AUTHORITY_POLICY,
      epoch: state.epoch + (action.method === "adopt" ? 1 : 0), expectedRevision: action.expectedRevision,
      requestID: action.requestID, method: action.method, payload: action.payload })
    const signed = await input.authority.sign(request, body, action.expectedHostRevision, signal)
    const signer = (await input.authority.read())!.signer!
    current()
    const receipt = await input.native.execute(signed, signal, () => {
      current(); input.authority.assertSignerCurrent(signer); return input.authority.assertReservationCurrent(body)
    })
    // Failure/ambiguity retains the protected reservation/disabled grant. No
    // re-signing, native retry, legacy method fallback or synthetic completion.
    current()
    const pending = (await input.authority.read())!
    if (pending.pendingDigest !== authorityDigest(body)) rejectAuthority("request-conflict")
    current()
    const settled = await input.authority.accept(request, pending.pendingDigest!, pending.revision, signal)
    // Stop revokes execution, not ownership of the still-existing map. Keep the
    // exact claim so terminal retries and map-only Delete retain the SAME gates.
    // Never reacquire a claim or substitute an unchecked denial-only capability.
    if (receipt.receipt.completion && body.method === "delete") {
      current(); await input.roots.releaseAfterMapDeletion(state.binding.roots, current)
    }
    return settled
  }
  return {
    execute,
    async create(request: FastifyRequest, raw: unknown, signal: AbortSignal) {
      canonicalAuthority(raw)
      const current = human(request, signal), action = createSchema.parse(raw)
      const connection = await input.manager.getSharedServiceConnection(input.workspaceID)
      current()
      if (!connection) rejectAuthority("observation-unavailable")
      const coordinator = await connection.client.session.get({ sessionID: action.coordinatorSessionId }, { signal })
      current()
      if (coordinator.parentID || coordinator.projectID !== input.scope.projectID
        || !await input.manager.ownsLocation(input.workspaceID, coordinator.location, connection.client)) rejectAuthority("binding-mismatch")
      const root = await input.roots.resolve(coordinator.location)
      current(); connection.assertCurrent()
      const missionID = `msn_${stableToken(`${input.scope.projectID}\0${action.requestID}`, 24)}`
      const target = { ...input.scope, missionID, coordinatorSessionID: coordinator.id, roots: [root] }
      const state = await input.authority.prepare(request, target, null, signal)
      current()
      const body = authorityIntentSchema.parse({ ...state.binding, version: 1, policy: MISSION_AUTHORITY_POLICY, epoch: 0,
        expectedRevision: 0, requestID: action.requestID, method: "create", payload: action.payload })
      const signed = await input.authority.sign(request, body, state.revision, signal)
      const signer = (await input.authority.read())!.signer!
      await input.native.execute(signed, signal, () => { current(); input.authority.assertSignerCurrent(signer); return input.authority.assertReservationCurrent(body) })
      const pending = (await input.authority.read())!
      current()
      if (pending.pendingDigest !== authorityDigest(body)) rejectAuthority("request-conflict")
      return input.authority.accept(request, pending.pendingDigest!, pending.revision, signal)
      // Prepared creation is NOT adoption or Play. Existing selected coordinator
      // is reused without changing location/agent/model or allocating specialists.
    },
  }
}
