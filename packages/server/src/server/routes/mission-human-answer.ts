import type { FastifyRequest } from "fastify"
import type { AuthManager } from "../../auth/manager"
import type { SettingsService } from "../../settings/service"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { ServiceConnection } from "../../workspaces/opencode-service"
import { z } from "zod"
import { canonicalAuthority } from "../../missions/authority-protocol"
import { HUMAN_ANSWER_HEADER, HUMAN_ANSWER_RPC, assertHumanAnswerFresh, humanAnswerBindingSchema,
  humanAnswerProof, humanAnswerProofSchema, humanAnswerResultSchema } from "../../missions/human-answer"
import { sameLocation, locationRequestOptions } from "../../opencode/compatibility/location"
import { isRemoteRequest } from "../../remote-control/request-origin"

type Manager = Pick<WorkspaceManager, "get" | "getSharedServiceConnection" | "ownsLocation" | "getServiceWslDistro">
type Deps = { auth: AuthManager; manager: Manager; settings: Pick<SettingsService, "getProfileScope">; bridgeToken: string }
const answerSchema = z.object({ answer: z.record(z.union([z.string().max(20000), z.array(z.string().max(20000)).max(32)])) }).strict()

/** Called INSIDE the normal proxy's owned native-session/request/deletion and
 * connection admission. It handles only the dock's real human answer path.
 * Auto/Yolo/SDK reply keeps the ordinary native route without human proof.
 * `undefined` means "use the ordinary native reply without a mark": every Form
 * outside a Mission family, and any Mission Form whose mark cannot be prepared
 * (auth disabled, plugin/binding unavailable) before anything was forwarded.
 * Only a dispatched mark reply can throw; its outcome is then uncertain. */
export async function replyMissionHumanAnswer(request: FastifyRequest, workspaceID: string, sessionID: string,
  formID: string, deps: Deps, connection: ServiceConnection, signal: AbortSignal) {
  if (request.headers[HUMAN_ANSWER_HEADER] !== "1") return undefined
  let prepared: Awaited<ReturnType<typeof prepareMissionHumanAnswer>>
  try { prepared = await prepareMissionHumanAnswer(request, workspaceID, sessionID, formID, deps, connection, signal) }
  catch {
    // Nothing was forwarded; the ordinary path keeps its own ownership checks.
    // Wayfinder then simply sees no proven UI decision for this Form.
    signal.throwIfAborted(); connection.assertCurrent()
    return undefined
  }
  if (!prepared) return undefined
  const { rpc, body, nativeOptions } = prepared
  return humanAnswerResultSchema.parse(await rpc.reply({ body, proof: humanAnswerProof(body, deps.bridgeToken) }, nativeOptions))
}

async function prepareMissionHumanAnswer(request: FastifyRequest, workspaceID: string, sessionID: string,
  formID: string, deps: Deps, connection: ServiceConnection, signal: AbortSignal) {
  const workspace = deps.manager.get(workspaceID), profile = deps.settings.getProfileScope()
  const distro = deps.manager.getServiceWslDistro(workspaceID), client = connection.client
  let id = sessionID, ownedLocation: { directory: string; workspaceID?: string } | undefined
  const seen = new Set<string>()
  let missionRoot = false
  for (let depth = 0; depth <= 32; depth++) {
    signal.throwIfAborted(); connection.assertCurrent()
    if (seen.has(id)) throw new Error("Human answer ancestry cycle")
    seen.add(id)
    const session = await client.session.get({ sessionID: id }, { signal })
    if (session.id !== id || !await deps.manager.ownsLocation(workspaceID, session.location, client, signal)
      || ownedLocation && !sameLocation(session.location, ownedLocation)) {
      throw new Error("Human answer session changed")
    }
    ownedLocation ??= session.location
    if (session.parentID) { id = session.parentID; continue }
    const marker = session.metadata?.["codenomad.mission"]
    missionRoot = !!marker && typeof marker === "object" && !Array.isArray(marker)
    break
  }
  // Ordinary conversations never take the mark path, nor write a mark.
  if (!missionRoot) return undefined
  // The mark is bound to a local cookie session that the bridge callback can
  // re-verify; a paired Remote Control device has none, so it answers ordinarily.
  if (isRemoteRequest(request)) return undefined
  const human = deps.auth.getSessionFromRequest(request)
  if (!deps.auth.isAuthEnabled() || !human || human.sessionId === "auth-disabled") return undefined
  const current = () => {
    signal.throwIfAborted(); connection.assertCurrent()
    const fresh = deps.auth.getSessionFromRequest(request)
    if (!deps.auth.isAuthEnabled() || fresh?.sessionId !== human.sessionId || fresh.username !== human.username
      || deps.manager.get(workspaceID) !== workspace || deps.manager.getServiceWslDistro(workspaceID) !== distro
      || canonicalAuthority(deps.settings.getProfileScope()) !== canonicalAuthority(profile)) throw new Error("Human answer admission changed")
  }
  current()
  const options = { location: { directory: ownedLocation!.directory }, ...locationRequestOptions(ownedLocation!), signal }
  const rpc = client.rpc(HUMAN_ANSWER_RPC)
  let rawBinding
  try { rawBinding = await rpc.binding({ sessionID, formID, profileID: profile.key,
    executionHost: distro ? `wsl:${distro}` : "local" }, options) }
  catch {
    // Without a binding there is no mark; the caller falls back to the ordinary reply.
    return undefined
  }
  current()
  if (rawBinding === null) return undefined
  const binding = humanAnswerBindingSchema.parse(rawBinding)
  if (binding.sessionID !== sessionID || binding.formID !== formID || !sameLocation(binding.location, ownedLocation!)) throw new Error("Human answer Form changed")
  const body = humanAnswerProofSchema.parse({ ...binding, workspaceID, cookieSessionID: human.sessionId,
    username: human.username, issuedAt: Date.now(), answer: answerSchema.parse(request.body).answer })
  current()
  // The plugin commits only the mark before replying; no signed receipt or
  // reconciliation lifecycle. Never cancel a dispatched answer with its observer.
  const { signal: _observer, ...nativeOptions } = options
  return { rpc, body, nativeOptions }
}

/** Existing private root bridge callback: actual AuthManager, no alternate auth
 * record or principal boolean supplied by a model. Nothing persists the cookie. */
export async function verifyMissionHumanAnswer(raw: unknown, deps: Omit<Deps, "bridgeToken">, signal: AbortSignal) {
  const body = humanAnswerProofSchema.parse(raw)
  assertHumanAnswerFresh(body); signal.throwIfAborted()
  const current = () => {
    signal.throwIfAborted(); assertHumanAnswerFresh(body)
    const human = deps.auth.getSessionFromHeaders({ cookie: `${deps.auth.getCookieName()}=${encodeURIComponent(body.cookieSessionID)}` })
    if (!deps.auth.isAuthEnabled() || human?.sessionId !== body.cookieSessionID || human.username !== body.username
      || deps.settings.getProfileScope().key !== body.profileID
      || body.executionHost !== (deps.manager.getServiceWslDistro(body.workspaceID) ? `wsl:${deps.manager.getServiceWslDistro(body.workspaceID)}` : "local"))
      throw new Error("Human answer authentication changed")
  }
  current()
  const workspace = deps.manager.get(body.workspaceID), connection = await deps.manager.getSharedServiceConnection(body.workspaceID)
  if (!workspace || !connection) throw new Error("Human answer owner unavailable")
  const session = await connection.client.session.get({ sessionID: body.sessionID }, { signal })
  current(); connection.assertCurrent()
  if (session.id !== body.sessionID || session.projectID !== body.projectID || !sameLocation(session.location, body.location)
    || !await deps.manager.ownsLocation(body.workspaceID, body.location, connection.client, signal)) throw new Error("Human answer Location changed")
  current(); connection.assertCurrent()
  if (deps.manager.get(body.workspaceID) !== workspace) throw new Error("Human answer workspace changed")
  return { admitted: true as const }
}
