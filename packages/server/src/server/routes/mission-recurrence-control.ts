import { realpath } from "node:fs/promises"
import path from "node:path"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AuthManager } from "../../auth/manager"
import type { SettingsService } from "../../settings/service"
import { canonicalScope } from "../../host-lifetime/protocol"
import { physical } from "../../missions/host-authority/private-files"
import { resolveStandingProfileSource } from "../../missions/host-authority/profile-source"
import { signNativeRecurrenceControl } from "../../missions/recurrence-control-proof"
import { CODENOMAD_MISSIONS_RPC, CODENOMAD_MISSIONS_RPC_ID } from "../../missions/rpc"
import { locationRequestOptions, sameLocation } from "../../opencode/compatibility/location"
import type { WorkspaceManager } from "../../workspaces/manager"
import { readFamilyAuthorityIdentity } from "../../workspaces/family-authority-claim"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { requestAdmission } from "../request-admission"

const paramsSchema = z.object({ id: z.string().trim().min(1).max(200), scheduleID: z.string().regex(/^[A-Za-z0-9_-]{3,100}$/) })
const bodySchema = z.object({ action: z.enum(["play", "pause", "stop"]), expectedRevision: z.number().int().nonnegative(),
  profileID: z.string().regex(/^[a-f0-9]{64}$/) }).strict()

/** A desktop-authenticated human intent, never an RPC caller's `approved` flag.
 * The only secret used for the native handoff is the existing bridge token. */
export function registerMissionRecurrenceControl(app: FastifyInstance, deps: {
  manager: Pick<WorkspaceManager, "get" | "getServiceLocation" | "getSharedServiceConnection" | "ownsLocation"
    | "getWorktreeIdentityForPath" | "getServiceWslDistro" | "getServicePathStyle">
  auth: AuthManager; settings: Pick<SettingsService, "configYamlPathForAuthority">
  bridgeToken: string; fence?: WorktreeDeletionFence
}) {
  app.post<{ Params: { id: string; scheduleID: string } }>("/api/workspaces/:id/missions/recurrence/:scheduleID/control", async (request, reply) => {
    const parsed = paramsSchema.safeParse(request.params), body = bodySchema.safeParse(request.body)
    if (!parsed.success || !body.success) return reply.code(400).send({ error: "Invalid recurrence control" })
    const session = deps.auth.getSessionFromRequest(request)
    if (!session) return reply.code(401).send({ error: "Authentication required" })
    const lifetime = requestAdmission(request, reply), { id, scheduleID } = parsed.data
    const workspace = deps.manager.get(id), location = deps.manager.getServiceLocation(id)
    if (!workspace || !location) { lifetime.dispose(); return reply.code(404).send({ error: "Workspace unavailable" }) }
    const currentDeletion = deps.fence?.captureDisplay([location.directory])
    let release: (() => void) | undefined
    try {
      const connection = await lifetime.wait(deps.manager.getSharedServiceConnection(id))
      if (!connection) throw new Error("Native connection unavailable")
      const current = (): true => {
        lifetime.signal.throwIfAborted(); connection.assertCurrent()
        if (deps.auth.getSessionFromRequest(request)?.sessionId !== session.sessionId || deps.manager.get(id) !== workspace
          || !sameLocation(deps.manager.getServiceLocation(id) ?? { directory: "" }, location)
          || currentDeletion && !currentDeletion()) throw new Error("Recurrence control changed")
        return true
      }
      current()
      if (!await deps.manager.ownsLocation(id, location, connection.client, lifetime.signal)) return reply.code(403).send({ error: "Foreign Location" })
      current()
      const options = { location: { directory: location.directory }, ...locationRequestOptions(location), signal: lifetime.signal }
      const resolved = await connection.client.location.get({ location: options.location }, options)
      const inventory = await connection.client.plugin.list({ location: options.location }, options)
      current()
      if (!sameLocation(resolved, location) || !await deps.manager.ownsLocation(id, resolved, connection.client, lifetime.signal)) return reply.code(403).send({ error: "Foreign Location" })
      if (!inventory.data.some(plugin => plugin.id === CODENOMAD_MISSIONS_RPC_ID && plugin.state.status === "active")) throw new Error("Mission plugin unavailable")
      const yaml = deps.settings.configYamlPathForAuthority()
      const scope = ["stable", "dev"].map(channel => canonicalScope(channel, yaml, process.cwd(), process.cwd()))
        .find(candidate => candidate.key === body.data.profileID)
      if (!scope) return reply.code(403).send({ error: "Selected Settings profile does not match schedule" })
      const distro = deps.manager.getServiceWslDistro(id)
      const executionHost = distro ? `wsl:${distro}` : `${process.platform}:local`
      const checkout = await deps.manager.getWorktreeIdentityForPath(id, location.directory)
      if (!checkout) throw new Error("Physical checkout unavailable")
      if (deps.fence && !(release = deps.fence.enter([checkout]))) throw new Error("Worktree deletion in progress")
      current()
      const family = await readFamilyAuthorityIdentity(checkout)
      const roots = { assertRoots: async (items: readonly { directory: string }[]) => {
        current()
        if (items.length !== 1 || items[0]?.directory !== location.directory
          || await deps.manager.getWorktreeIdentityForPath(id, location.directory) !== checkout
          || await readFamilyAuthorityIdentity(checkout) !== family
          || !await deps.manager.ownsLocation(id, location, connection.client, lifetime.signal)) throw new Error("Physical root changed")
      } }
      const profileSource = await resolveStandingProfileSource({ settings: deps.settings,
        descriptor: { scope, physicalProfile: physical(await realpath(path.dirname(yaml))), executionHost },
        binding: { profileID: body.data.profileID, executionHost, projectID: resolved.project.id,
          projectCanonical: resolved.project.canonical, roots: [{ mode: "directory-only", directory: location.directory }] },
        manager: deps.manager, roots, workspaceID: id, assertCurrent: current })
      await roots.assertRoots([{ directory: location.directory }])
      current()
      const intent = { scheduleID, expectedRevision: body.data.expectedRevision, action: body.data.action,
        profileSource, issuedAt: Date.now() }
      const result = await connection.client.rpc(CODENOMAD_MISSIONS_RPC).recurrenceControl({
        ...intent, proof: signNativeRecurrenceControl(intent, deps.bridgeToken),
      }, options) as { version: 1; scheduleID: string; revision: number; state: "running" | "paused" | "stopped"; epoch: number }
      current()
      if (result.scheduleID !== scheduleID || result.revision !== body.data.expectedRevision + 1) throw new Error("Native control acknowledgement changed")
      return result
    } catch (error) {
      request.log.warn({ err: error, workspaceId: id }, "Mission recurrence control unavailable")
      // Unknown native replies are never retried: the exact signed parent/read
      // snapshot is the only reconciliation path for this expected revision.
      return reply.code(503).send({ error: "Recurrence control uncertain; refresh before another action" })
    } finally { release?.(); lifetime.dispose() }
  })
}
