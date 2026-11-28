import { z } from "zod"
import { createHash } from "node:crypto"
import { projectToolCommand } from "../../missions/project-control-tool"
import { signProjectControl, verifyProjectControl, type ProjectControlProof } from "../../missions/project-control-proof"
import { CODENOMAD_MISSIONS_RPC } from "../../missions/rpc"
import type { MissionSnapshot } from "../../missions/model"
import { ownedMissionAgent } from "./mission-agent-owner"
import { prepareMissionMapMutation } from "./mission-map-mutation"
import type { MissionRouteDeps } from "./missions"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { SettingsService } from "../../settings/service"
import { missionBriefingRequestText, missionAcceptsCoordinatorMessage } from "../../missions/briefing-request"
import { locationRequestOptions, sameLocation } from "../../opencode/compatibility/location"
import { syncSessionGitContext } from "../../workspaces/session-git-context"
import { syncSessionMemoryContext } from "../../workspaces/session-memory-context"
import type { MemoryService } from "../../memory/service"
import { MissionControlError } from "../../missions/control-error"
import { readMissionMutationError } from "../../missions/rpc-errors"
import { isPlainObject } from "../../settings/merge-patch"
import { sessionPermissionTarget } from "./session-permission-mode"

type Deps = Omit<MissionRouteDeps, "workspaceManager" | "settings"> & {
  workspaceManager: MissionRouteDeps["workspaceManager"] & Pick<WorkspaceManager, "list" | "getSessionEnvironment">
    & Partial<Pick<WorkspaceManager, "getServiceWslDistro">>
  settings?: MissionRouteDeps["settings"] & Partial<Pick<SettingsService, "getRawConfigOwner">>
  memory?: MemoryService
}
const commandSchema = z.object({ kind: z.literal("project-control"), input: projectToolCommand }).strict()
const retained = new WeakMap<object, Map<string, { release(): void; fingerprint: string; observed: boolean; tool: ProjectControlProof["command"]["tool"] }>>()
const receipt = (value: unknown) => value as { receipt?: { state?: string; retryable?: boolean; command?: { tool?: string; input?: { action?: string; deleteManagedSessions?: boolean } } } }

/** Only the authenticated private bridge supplies an agent principal. Public HTTP
 * controls keep their human entry and share the underlying mutation admission. */
export async function controlAgentMission(deps: Deps, sessionID: string, raw: unknown, signal: AbortSignal) {
  let { input: command } = commandSchema.parse(raw)
  const agent = await ownedMissionAgent(deps.workspaceManager, sessionID, signal)
  if (!deps.bridgeToken || !deps.worktreeDeletionFence) throw new Error("Mission project control unavailable")
  return execute(command)

  async function execute(selected: typeof command) {
    const owned = await prepareMissionMapMutation({ manager: deps.workspaceManager, fence: deps.worktreeDeletionFence,
      workspaceID: agent.workspace.id, directory: agent.session.location.directory, signal })
    return owned.run(async (rpc, options) => {
      const call = async (value: typeof command) => {
        await owned.refresh(); await agent.refresh()
        const body = { principal: { kind: "agent" as const, sessionID }, projectID: agent.session.projectID,
          directory: owned.location.directory, command: value, issuedAt: Date.now() }
        const result = z.object({ json: z.string().max(100_000) }).strict().parse(
          await rpc.projectControl({ ...body, proof: signProjectControl(body, deps.bridgeToken!) }, { ...options, signal }))
        await owned.refresh(); await agent.refresh()
        return JSON.parse(result.json) as Record<string, unknown>
      }
      if (selected.tool === "delete" && selected.input.action === "delete" && selected.input.deleteManagedSessions === undefined) {
        const before = await call({ tool: "delete", input: { action: "read", missionID: selected.input.missionID, requestID: selected.input.requestID } })
        const original = receipt(before).receipt?.command?.input?.deleteManagedSessions
        let preference: unknown = false
        if (original === undefined) {
          if (!deps.settings?.getRawConfigOwner) throw new Error("Mission deletion preference unavailable")
          const ui = deps.settings.getRawConfigOwner("ui")
          if (ui.settings !== undefined && !isPlainObject(ui.settings)) throw new Error("Mission deletion preference invalid")
          preference = isPlainObject(ui.settings) ? ui.settings.missionDeleteSessions ?? false : false
          if (typeof preference !== "boolean") throw new Error("Mission deletion preference invalid")
        }
        selected = { ...selected, input: { ...selected.input, deleteManagedSessions: original ?? preference as boolean } }
      }
      const key = `${agent.session.projectID}\0${selected.input.missionID}\0${selected.input.requestID}`
      let registry = retained.get(deps.worktreeDeletionFence!)
      if (!registry) { registry = new Map(); retained.set(deps.worktreeDeletionFence!, registry) }
      const fingerprint = JSON.stringify({ ...selected, input: { ...selected.input, retry: undefined } })
      const held = registry.get(key)
      if (selected.input.action !== "read") {
        if (held && held.fingerprint !== fingerprint)
          return { refused: true, code: "request-conflict", missionID: selected.input.missionID, requestID: selected.input.requestID }
        const prefix = `${agent.session.projectID}\0${selected.input.missionID}\0`
        for (const [other, record] of registry) if (other.startsWith(prefix) && other !== key && !held) {
          const observed = await call({ tool: record.tool, input: { action: "read", missionID: selected.input.missionID,
            requestID: other.slice(prefix.length) } } as typeof command)
          const original = receipt(observed).receipt
          if (original?.state === "completed" || original?.state === "refused") { record.release(); registry.delete(other); continue }
          const independent = original?.command && original.command.tool !== "delete"
            && !(original.command.tool === "control" && ["play", "resume", "pause", "interrupt", "stop"].includes(original.command.input?.action ?? ""))
          if (selected.tool !== "control" || selected.input.action !== "stop" || !(original?.retryable || independent))
            return { refused: true, code: "control-pending", missionID: selected.input.missionID }
        }
        if (held) {
          const observed = await call({ tool: selected.tool, input: { action: "read",
            missionID: selected.input.missionID, requestID: selected.input.requestID } } as typeof command)
          const original = receipt(observed).receipt
          if (original?.state === "completed" || original?.state === "refused") { held.release(); registry.delete(key); return observed }
          if (!selected.input.retry || !held.observed || !original?.retryable) return observed
        }
      }
      const hold = () => {
        if (!registry!.has(key)) owned.retain(release => { registry!.set(key, { release, fingerprint, observed: false, tool: selected.tool }); return undefined })
      }
      try {
        const result = await call(selected)
        const state = receipt(result).receipt?.state
        if (selected.input.action === "read" && held) held.observed = receipt(result).receipt?.retryable === true
        if (state === "completed" || state === "refused") { registry.get(key)?.release(); registry.delete(key) }
        else if (selected.input.action !== "read") hold()
        return result
      } catch (error) {
        const rejection = readMissionMutationError(error)
        if (rejection || error instanceof MissionControlError)
          return { refused: true, code: rejection?.code ?? (error as MissionControlError).code,
            missionID: selected.input.missionID, requestID: selected.input.requestID }
        if (selected.input.action !== "read") hold()
        return { uncertain: true, missionID: selected.input.missionID, requestID: selected.input.requestID }
      }
    })
  }
}

/** Revalidate the signed native request through the exact owning backend. No
 * authenticated human-answer capability is involved in agent control. */
export async function verifyAgentMissionControl(deps: Deps, sessionID: string, raw: unknown, signal: AbortSignal) {
  const command = z.object({ kind: z.enum(["project-control-verify", "project-update"]), input: z.unknown() }).strict().parse(raw)
  if (!deps.bridgeToken) throw new Error("Mission principal unavailable")
  const proof = verifyProjectControl(command.input, deps.bridgeToken)
  const agent = await ownedMissionAgent(deps.workspaceManager, sessionID, signal)
  if (proof.principal.sessionID !== sessionID || proof.projectID !== agent.session.projectID
    || !sameLocation({ directory: proof.directory }, agent.session.location)) throw new Error("Foreign Mission agent principal")
  await agent.refresh()
  if (command.kind === "project-control-verify") return { verified: true }
  return requestUpdate(deps, agent, { ...proof, proof: (command.input as ProjectControlProof).proof }, signal)
}

async function requestUpdate(deps: Deps, agent: Awaited<ReturnType<typeof ownedMissionAgent>>, proof: ProjectControlProof, signal: AbortSignal) {
  const command = proof.command
  if (command.tool !== "control" || command.input.action !== "request-update") throw new Error("Invalid Mission briefing request")
  const { client, workspace } = agent, original = command.input
  const read = async () => {
    const state = await client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, agent.options) as MissionSnapshot
    await agent.refresh()
    const mission = state.missions.find(m => m.id === original.missionID)
    if (state.projectID !== agent.session.projectID || state.controlUnavailable || !mission || mission.controlUnavailable
      || !missionAcceptsCoordinatorMessage(mission)
      || mission.revision !== original.expectedRevision) throw new Error("Mission briefing admission changed")
    return mission
  }
  const mission = await read(), actor = mission.actors.find(a => a.sessionId === mission.coordinatorSessionId)
  const assertCurrent = async () => {
    await agent.refresh()
    const fresh = await read(), target = await client.session.get({ sessionID: mission.coordinatorSessionId }, { signal })
    if (!actor || fresh.coordinatorSessionId !== mission.coordinatorSessionId || target.parentID
      || target.projectID !== mission.projectID || !sameLocation(target.location, actor.location)
      || !await deps.workspaceManager.ownsLocation(workspace.id, target.location, client, { signal, strict: true }))
      throw new Error("Mission coordinator changed")
    return target
  }
  const owned = await prepareMissionMapMutation({ manager: deps.workspaceManager, fence: deps.worktreeDeletionFence,
    workspaceID: workspace.id, directory: actor?.location.directory, signal })
  return owned.run(async () => {
    await assertCurrent()
    const variables = await deps.workspaceManager.getSessionEnvironment(workspace.id, signal)
    await assertCurrent()
    await client.session.environment({ sessionID: mission.coordinatorSessionId, variables }, { signal })
    try { await syncSessionGitContext(client, mission.coordinatorSessionId, signal) } catch { /* advisory */ }
    await syncSessionMemoryContext(agent.connection, deps.memory, mission.coordinatorSessionId, signal)
    await owned.refresh()
    const target = await assertCurrent()
    const modes = deps.permissionModes
    if (modes?.mayBeSupervised(target)) {
      const current = () => { signal.throwIfAborted(); agent.connection.assertCurrent() }
      await modes.refresh(sessionPermissionTarget(target, {
        client, current, signal, distro: deps.workspaceManager.getServiceWslDistro?.(workspace.id),
      }))
      await assertCurrent()
    }
    const id = `msg_${createHash("sha256").update(`mission-briefing\0${mission.id}\0${original.requestID}`).digest("hex").slice(0, 28)}`
    await client.session.prompt({ sessionID: mission.coordinatorSessionId, id, delivery: "steer",
      text: missionBriefingRequestText(mission, original.requestID!, original.language ?? "en") },
      { ...locationRequestOptions(actor!.location), signal })
    return { admitted: true, messageID: id }
  })
}
