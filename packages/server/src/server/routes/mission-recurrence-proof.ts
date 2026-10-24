import { z } from "zod"
import type { AuthManager } from "../../auth/manager"
import type { WorkspaceManager } from "../../workspaces/manager"
import { assertRecurrenceProofFresh, recurrenceControlRequestDigest } from "../../missions/recurrence-control-proof"
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

const proofSchema = z.object({ sessionID: z.string().min(1).max(256), workspaceID: z.string().min(1).max(200),
  requestID: z.string().min(1).max(128), location: z.object({ directory: z.string().min(1).max(4096),
    workspaceID: z.string().optional() }).strict(), scheduleID: z.string().regex(/^[A-Za-z0-9_-]{3,100}$/),
  expectedRevision: z.number().int().nonnegative(), action: z.enum(["play", "pause", "stop", "resume", "run-now", "check", "create"]),
  configDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  profileSource: z.object({ profileID: z.string(), executionHost: z.string(), configYamlPath: z.string() }).strict(),
  issuedAt: z.number().int().nonnegative(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()

/** Read-only callback through the existing private bridge. No registration of
 * an alternate auth session/store: cookie admission is checked in AuthManager,
 * paired devices in the live Remote Control registry. */
export async function verifyHumanRecurrenceRequest(input: unknown, deps: {
  auth: Pick<AuthManager, "isAuthEnabled" | "getSessionFromHeaders" | "getCookieName">
  manager: Pick<WorkspaceManager, "get" | "getSharedServiceConnection" | "ownsLocation" | "getServiceWslDistro">
  settings?: Pick<SettingsService, "getProfileScope">
  remoteDevices?: HumanDeps["remoteDevices"]
}, signal: AbortSignal, now: () => number = Date.now): Promise<{ admitted: true }> {
  const body = proofSchema.parse(input), { digest, ...identity } = body
  signal.throwIfAborted()
  assertRecurrenceProofFresh(body.issuedAt, now())
  if (!deps.auth.isAuthEnabled() || body.sessionID === "auth-disabled" || recurrenceControlRequestDigest(identity) !== digest) throw new Error("Recurrence human request unavailable")
  // The signed sessionID names its principal: a paired device stays one, never a cookie.
  const authenticated = () => body.sessionID.startsWith(REMOTE_DEVICE_SESSION)
    ? body.sessionID.length > REMOTE_DEVICE_SESSION.length
      && deps.remoteDevices?.isDeviceAuthorized(body.sessionID.slice(REMOTE_DEVICE_SESSION.length)) === true
    : deps.auth.getSessionFromHeaders({ cookie: `${deps.auth.getCookieName()}=${body.sessionID}` })?.sessionId === body.sessionID
  if (!authenticated() || !deps.settings
    || deps.settings.getProfileScope().key !== body.profileSource.profileID) throw new Error("Recurrence human request unavailable")
  const workspace = deps.manager.get(body.workspaceID)
  const distro = deps.manager.getServiceWslDistro(body.workspaceID)
  if (body.profileSource.executionHost !== (distro ? `wsl:${distro}` : "local")) throw new Error("Recurrence execution host changed")
  const connection = await deps.manager.getSharedServiceConnection(body.workspaceID)
  if (!workspace || !connection || !await deps.manager.ownsLocation(body.workspaceID, body.location, connection.client, signal)) throw new Error("Recurrence owner unavailable")
  const location = await connection.client.location.get({ location: { directory: body.location.directory } }, { signal })
  connection.assertCurrent(); signal.throwIfAborted()
  if (!sameLocation(location, body.location) || deps.manager.get(body.workspaceID) !== workspace
    || deps.manager.getServiceWslDistro(body.workspaceID) !== distro
    || !deps.auth.isAuthEnabled() || !authenticated()) throw new Error("Recurrence owner changed")
  assertRecurrenceProofFresh(body.issuedAt, now())
  return { admitted: true }
}
