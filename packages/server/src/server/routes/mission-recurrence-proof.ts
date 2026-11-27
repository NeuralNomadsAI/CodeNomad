import type { AuthManager } from "../../auth/manager"
import type { WorkspaceManager } from "../../workspaces/manager"
import { assertRecurrenceProofFresh, assertSchedulePrincipalAction, recurrenceControlProofSchema,
  recurrenceControlRequestDigest, recurrenceSchedulePrincipal, type RecurrenceControlProofBody } from "../../missions/recurrence-control-proof"
import { missionPreparationBindingSchema } from "../../missions/creation-intent"
import { CODENOMAD_MISSIONS_RPC } from "../../missions/rpc"
import { canonicalAuthority } from "../../missions/authority-protocol"
import { automaticMissionStartID } from "../../missions/preparation-result"
import { missionScheduleID } from "../../missions/mission-schedule-contract"
import { sameLocation } from "../../opencode/compatibility/location"
import type { SettingsService } from "../../settings/service"
import type { FastifyRequest } from "fastify"
import type { RemoteControlManager } from "../../remote-control/manager"
import { isRemoteRequest, remoteDeviceOf } from "../../remote-control/request-origin"

// AuthManager names a paired device session `remote-device:<id>`; login cookie
// session IDs are base64url and can never take this form.
const REMOTE_DEVICE_SESSION = "remote-device:"
type HumanDeps = { auth: Pick<AuthManager, "isAuthEnabled" | "getSessionFromRequest">
  /** Live Remote Control device authorization; absent means no paired device qualifies. */
  remoteDevices?: Pick<RemoteControlManager, "isDeviceAuthorized"> }

/** The authenticated human behind a recurring control, revalidated on every
 * check: a live login cookie session (auth enabled) or, from the Remote Control
 * ingress only (socket membership, never a header), a paired device that is
 * still authorized. Local auth must be enabled either way. */
export function recurrenceHumanSession(request: FastifyRequest, deps: HumanDeps): { username: string; sessionId: string } | undefined {
  const session = deps.auth.getSessionFromRequest(request)
  if (!deps.auth.isAuthEnabled() || !session || session.sessionId === "auth-disabled") return undefined
  if (isRemoteRequest(request)) {
    const deviceID = remoteDeviceOf(request)
    return deviceID && session.sessionId === `${REMOTE_DEVICE_SESSION}${deviceID}`
      && deps.remoteDevices?.isDeviceAuthorized(deviceID) === true ? session : undefined
  }
  return session.sessionId.startsWith(REMOTE_DEVICE_SESSION) ? undefined : session
}

export type VerifyScheduleAgentCreation = (body: RecurrenceControlProofBody,
  signal: AbortSignal) => Promise<boolean>
const preparationProofSchema = z.object({ binding: missionPreparationBindingSchema.optional() }).strict()

/** Read-only callback through the existing private bridge. No registration of
 * an alternate auth session/store: cookie admission is checked in AuthManager,
 * paired devices in the live Remote Control registry. */
export async function verifyRecurrenceRequest(input: unknown, deps: {
  auth: Pick<AuthManager, "isAuthEnabled" | "getSessionFromHeaders" | "getCookieName">
  manager: Pick<WorkspaceManager, "get" | "getSharedServiceConnection" | "ownsLocation" | "getServiceWslDistro">
  settings?: Pick<SettingsService, "getProfileScope">
  remoteDevices?: HumanDeps["remoteDevices"]
  /** Reads the original immutable preparation binding; absence refuses agent CREATE. */
  verifyAgentCreation?: VerifyScheduleAgentCreation
}, signal: AbortSignal, now: () => number = Date.now): Promise<{ admitted: true }> {
  const body = recurrenceControlProofSchema.parse(input), { digest, ...identity } = body
  const principal = recurrenceSchedulePrincipal(body)
  assertSchedulePrincipalAction(principal, body.action)
  signal.throwIfAborted()
  assertRecurrenceProofFresh(body.issuedAt, now())
  if (recurrenceControlRequestDigest(identity) !== digest) throw new Error("Recurrence request unavailable")
  // Only human principals enter cookie/device authentication.
  const authenticated = () => principal.kind === "agent" || deps.auth.isAuthEnabled() && principal.sessionID !== "auth-disabled"
    && (principal.sessionID.startsWith(REMOTE_DEVICE_SESSION)
      ? principal.sessionID.length > REMOTE_DEVICE_SESSION.length
        && deps.remoteDevices?.isDeviceAuthorized(principal.sessionID.slice(REMOTE_DEVICE_SESSION.length)) === true
      : deps.auth.getSessionFromHeaders({ cookie: `${deps.auth.getCookieName()}=${principal.sessionID}` })?.sessionId === principal.sessionID)
  if (!authenticated() || !deps.settings
    || deps.settings.getProfileScope().key !== body.profileSource.profileID) throw new Error("Recurrence request unavailable")
  const workspace = deps.manager.get(body.workspaceID)
  const distro = deps.manager.getServiceWslDistro(body.workspaceID)
  if (body.profileSource.executionHost !== (distro ? `wsl:${distro}` : "local")) throw new Error("Recurrence execution host changed")
  const connection = await deps.manager.getSharedServiceConnection(body.workspaceID)
  if (!workspace || !connection || !await deps.manager.ownsLocation(body.workspaceID, body.location, connection.client, { signal })) throw new Error("Recurrence owner unavailable")
  const location = await connection.client.location.get({ location: { directory: body.location.directory } }, { signal })
  if (principal.kind === "agent") {
    const authorCurrent = async () => {
      const author = await connection.client.session.get({ sessionID: principal.author.coordinatorSessionID }, { signal })
       if (author.id !== principal.author.coordinatorSessionID || author.projectID !== location.project.id
         || principal.creationRequestID && !sameLocation(author.location, body.location)
        || !await deps.manager.ownsLocation(body.workspaceID, author.location, connection.client, { signal }))
        throw new Error("Recurrence agent owner unavailable")
    }
    await authorCurrent()
    if (body.action === "create" && principal.creationRequestID) {
      if (body.requestID !== principal.creationRequestID
        || body.scheduleID !== missionScheduleID(location.project.id, location.project.canonical, body.requestID))
        throw new Error("Recurrence agent creation identity differs")
      if (deps.verifyAgentCreation) {
        if (!await deps.verifyAgentCreation(body, signal)) throw new Error("Recurrence agent creation unavailable")
      } else {
        const result = preparationProofSchema.parse(await connection.client.rpc(CODENOMAD_MISSIONS_RPC).schedulePreparationRead(
          { creationRequestID: principal.creationRequestID }, { location: { directory: body.location.directory }, signal }))
        const { kind: _kind, ...expected } = principal
        if (!result.binding || canonicalAuthority(result.binding) !== canonicalAuthority(expected))
          throw new Error("Recurrence agent creation unavailable")
      }
    } else if (principal.creationRequestID) {
      const result = await connection.client.rpc(CODENOMAD_MISSIONS_RPC).scheduleRead({ missionID: body.scheduleID },
        { location: { directory: body.location.directory }, signal }) as { document?: {
          firstPlayedAt: number | null; revision: number; state: string; creation?: { requestID: string; digest: string; author?: unknown;
            automaticStart?: { requestID: string; attempted: boolean }; input?: { startOnCreation: boolean } } } }
      const document = result.document, creation = document?.creation
      if (!document || document.firstPlayedAt !== null || document.state !== "paused" || document.revision !== body.expectedRevision
        || creation?.requestID !== principal.creationRequestID || creation.digest !== principal.creationDigest
        || canonicalAuthority(creation.author ?? null) !== canonicalAuthority(principal.author)
        || creation.input?.startOnCreation !== true || creation.automaticStart?.attempted !== false
        || creation.automaticStart.requestID !== body.requestID || body.requestID !== automaticMissionStartID(creation.requestID))
        throw new Error("Recurrence agent first Play unavailable")
    }
    await authorCurrent()
  }
  connection.assertCurrent(); signal.throwIfAborted()
  if (!sameLocation(location, body.location) || deps.manager.get(body.workspaceID) !== workspace
    || deps.manager.getServiceWslDistro(body.workspaceID) !== distro
    || deps.settings.getProfileScope().key !== body.profileSource.profileID
    || !authenticated()) throw new Error("Recurrence owner changed")
  assertRecurrenceProofFresh(body.issuedAt, now())
  return { admitted: true }
}
import { z } from "zod"
