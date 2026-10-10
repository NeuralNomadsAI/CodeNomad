import { realpath } from "node:fs/promises"
import path from "node:path"
import type { FastifyRequest } from "fastify"
import type { AuthManager } from "../../auth/manager"
import type { SettingsService } from "../../settings/service"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { canonicalAuthority } from "../../missions/authority-protocol"
import { physical } from "../../missions/host-authority/private-files"
import { resolveStandingProfileSource } from "../../missions/host-authority/profile-source"
import { recurrenceControlRequestDigest, signNativeRecurrenceControl } from "../../missions/recurrence-control-proof"
import { recurrenceControlHttpSchema } from "../../missions/recurrence-control-contract"
import { sameLocation, locationRequestOptions } from "../../opencode/compatibility/location"
import { resolveRecurrenceRoot } from "./mission-recurrence-roots"
import { captureRecurrenceControlHoldRead, holdRecurrenceControl } from "./mission-recurrence-holds"
import { captureDisplayIdentities } from "../../workspaces/worktree-display-identity"

/** Exact Settings profile and currently owned physical root are resolved only
 * inside the authenticated human request, never from native RPC path options. */
export async function prepareHumanRecurrenceControl(request: FastifyRequest, workspaceID: string, raw: unknown,
  deps: { auth: AuthManager; settings: Pick<SettingsService, "getProfileScope" | "configYamlPathForAuthority">;
    manager: Pick<WorkspaceManager, "get" | "getServiceLocation" | "getServiceDirectoryForPath" | "getSharedServiceConnection"
      | "ownsLocation" | "getServiceWslDistro" | "getServicePathStyle" | "getWorktreeIdentityForPath" | "getHostPathForServicePath">;
    fence: WorktreeDeletionFence; bridgeToken: string }, signal: AbortSignal) {
  const input = recurrenceControlHttpSchema.parse(raw), session = deps.auth.getSessionFromRequest(request)
  if (!deps.auth.isAuthEnabled() || !session || session.sessionId === "auth-disabled") throw new Error("Human authentication required")
  const workspace = deps.manager.get(workspaceID), base = deps.manager.getServiceLocation(workspaceID)
  if (!workspace || !base) throw new Error("Workspace unavailable")
  const profile = deps.settings.getProfileScope(), distro = deps.manager.getServiceWslDistro(workspaceID)
  const directory = input.directory ? await deps.manager.getServiceDirectoryForPath(workspaceID, input.directory) : base.directory
  if (!directory) throw new Error("Location unavailable")
  const connection = await deps.manager.getSharedServiceConnection(workspaceID)
  if (!connection) throw new Error("Native connection unavailable")
  const previousHold = input.retry ? captureRecurrenceControlHoldRead(deps.fence, workspaceID, { directory }, {
    scheduleID: input.scheduleID, requestID: input.requestID, action: input.action,
    expectedRevision: input.expectedRevision,
  }, connection) : undefined
  const display = previousHold ?? await captureDisplayIdentities(deps.fence, deps.manager, workspaceID, [base.directory, directory]) ?? (() => false)
  const current = (): true => {
    signal.throwIfAborted(); connection.assertCurrent()
    if (!deps.auth.isAuthEnabled() || deps.auth.getSessionFromRequest(request)?.sessionId !== session.sessionId
      || deps.manager.get(workspaceID) !== workspace || !sameLocation(deps.manager.getServiceLocation(workspaceID) ?? { directory: "" }, base)
      || deps.manager.getServiceWslDistro(workspaceID) !== distro || !display()
      || canonicalAuthority(deps.settings.getProfileScope()) !== canonicalAuthority(profile)) throw new Error("Human recurrence admission changed")
    return true
  }
  const client = connection.client
  if (!await deps.manager.ownsLocation(workspaceID, { directory }, client, signal)) throw new Error("Location is not owned")
  const location = await client.location.get({ location: { directory } }, { signal })
  const baseInfo = await client.location.get({ location: { directory: base.directory } }, { ...locationRequestOptions(base), signal })
  current()
  if (location.project.id !== baseInfo.project.id || location.project.canonical !== baseInfo.project.canonical
    || !sameLocation(location, { directory }) || !await deps.manager.ownsLocation(workspaceID, location, client, signal)) throw new Error("Foreign native Location")
  const checkout = await deps.manager.getWorktreeIdentityForPath(workspaceID, directory)
  if (!checkout) throw new Error("Checkout unavailable")
  let hold: ReturnType<typeof holdRecurrenceControl> | undefined
  try {
    hold = holdRecurrenceControl(deps.fence, { scheduleID: input.scheduleID, requestID: input.requestID,
      action: input.action, expectedRevision: input.expectedRevision,
      workspaceID, location: { directory }, connection, owner: { workspace, projectID: location.project.id,
        projectCanonical: location.project.canonical, checkout } }, () => deps.fence.enter([checkout]), input.retry)
    if (!hold) throw new Error("Worktree deletion in progress")
    const physicalRoot = await resolveRecurrenceRoot(deps.manager, workspaceID, directory, location.project.canonical, distro)
    const assertRoots = async () => {
      current()
      if (await deps.manager.getWorktreeIdentityForPath(workspaceID, directory) !== checkout
        || canonicalAuthority(await resolveRecurrenceRoot(deps.manager, workspaceID, directory, location.project.canonical, distro)) !== canonicalAuthority(physicalRoot)
        || !await deps.manager.ownsLocation(workspaceID, location, client, signal)) throw new Error("Physical root changed")
      current()
    }
    const yaml = deps.settings.configYamlPathForAuthority(), executionHost = distro ? `wsl:${distro}` : "local"
    const profileSource = await resolveStandingProfileSource({ settings: deps.settings,
      descriptor: { scope: profile, physicalProfile: physical(await realpath(path.dirname(yaml))), executionHost },
      binding: { profileID: profile.key, executionHost, projectID: location.project.id, projectCanonical: location.project.canonical,
        roots: [{ mode: "directory-only", directory }] }, manager: deps.manager, roots: { assertRoots }, workspaceID, assertCurrent: current })
    await assertRoots()
    const identity = { sessionID: session.sessionId, workspaceID, requestID: input.requestID,
      location: { directory },
      scheduleID: input.scheduleID, action: input.action, expectedRevision: input.expectedRevision,
      profileSource, issuedAt: Date.now() }
    const body = { ...identity, digest: recurrenceControlRequestDigest(identity) }
    current()
    return { body: { ...body, ...(input.retry ? { retry: true } : {}), proof: signNativeRecurrenceControl(body, deps.bridgeToken) }, current,
      client, location: identity.location, hold, dispose: hold.dispose }
  } catch (error) { hold?.dispose(); throw error }
}
