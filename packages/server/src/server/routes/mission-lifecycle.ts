import { isSessionNotFoundError } from "@opencode/client"
import { z } from "zod"
import { CODENOMAD_MISSIONS_RPC } from "../../missions/rpc"
import { stableToken } from "../../missions/journal"
import type { MissionSnapshot } from "../../missions/model"
import { matchesExecution } from "../../missions/execution"
import { sameLocation, locationRequestOptions } from "../../opencode/compatibility/location"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { syncSessionGitContext } from "../../workspaces/session-git-context"

const schema = z.object({ kind: z.literal("lifecycle"), input: z.object({
  missionID: z.string().min(1).max(100), operationID: z.string().min(1).max(100), sessionID: z.string().regex(/^ses_/).max(240),
}).strict() }).strict()
type Manager = Pick<WorkspaceManager, "list" | "getSharedServiceConnection" | "ownsLocation" | "getWorktreeIdentityForPath" | "getSessionEnvironment">

export async function applyMissionLifecycle(manager: Manager, fence: WorktreeDeletionFence, coordinatorID: string, command: unknown, signal: AbortSignal) {
  const { input } = schema.parse(command)
  const owner = await Promise.any(manager.list().map(async workspace => {
    const connection = await manager.getSharedServiceConnection(workspace.id)
    if (!connection) throw new Error("Workspace unavailable")
    const coordinator = await connection.client.session.get({ sessionID: coordinatorID }, { signal })
    if (coordinator.parentID || !await manager.ownsLocation(workspace.id, coordinator.location, connection.client)) throw new Error("Foreign coordinator")
    return { connection, workspace, coordinator }
  })).catch(() => undefined)
  if (!owner) throw new Error("Missing mission owner")
  const { connection, workspace, coordinator } = owner
  const client = connection.client
  const snapshot = await client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, {
    location: { directory: coordinator.location.directory }, ...locationRequestOptions(coordinator.location), signal,
  }) as MissionSnapshot
  const mission = snapshot.missions.find(mission => mission.id === input.missionID)
  const operation = mission?.control
  const target = operation?.targets.find(target => target.sessionID === input.sessionID)
  if (!mission || snapshot.projectID !== coordinator.projectID || mission.projectID !== coordinator.projectID
    || mission.coordinatorSessionId !== coordinatorID || !operation || operation.id !== input.operationID || !target
    || !operation.pending.includes(target.sessionID)) throw new Error("No pending mission control authority")
  const targetActor = mission.actors.find(actor => actor.sessionId === target.sessionID)
  if (!targetActor || !sameLocation(targetActor.location, target.location)
    || !await manager.ownsLocation(workspace.id, target.location, client)) throw new Error("Foreign mission actor")
  if (snapshot.missions.some(other => other.id !== mission.id && other.status === "active"
    && other.actors.some(actor => actor.sessionId === target.sessionID))) throw new Error("Mission actor is shared")
  const expectedState = operation.action === "start" ? "running" : operation.action === "pause" ? "paused" : "stopped"
  if (mission.runState !== expectedState || (operation.action !== "stop" && mission.status !== "active")) throw new Error("Mission control superseded")
  const identities = await Promise.all([coordinator.location, target.location].map(location => manager.getWorktreeIdentityForPath(workspace.id, location.directory)))
  if (identities.some(identity => !identity)) throw new Error("Missing mission worktree")
  const release = fence.enter(identities as string[])
  if (!release) throw new Error("Worktree mutation in progress")
  const current = () => { signal.throwIfAborted(); connection.assertCurrent() }
  try {
    current()
    const checkTarget = async () => {
      const session = await client.session.get({ sessionID: target.sessionID }, { signal })
      if (session.parentID || session.projectID !== mission.projectID || !sameLocation(session.location, target.location)) throw new Error("Mission actor moved")
      if (operation.action === "start" && mission.tasks.some(task => task.actorSessionId === session.id
        && (task.status === "queued" || task.status === "dispatching") && !matchesExecution(task.execution, session))) throw new Error("Actor selection changed")
      return session
    }
    try { await checkTarget() }
    catch (error) {
      if (operation.action !== "start" && isSessionNotFoundError(error)) return { applied: true }
      throw error
    }
    const freshCoordinator = await client.session.get({ sessionID: coordinatorID }, { signal })
    if (freshCoordinator.parentID || freshCoordinator.projectID !== coordinator.projectID || !sameLocation(freshCoordinator.location, coordinator.location)) throw new Error("Coordinator moved")
    if (operation.action === "start") {
      const variables = await manager.getSessionEnvironment(workspace.id, signal)
      await checkTarget()
      current()
      await client.session.environment({ sessionID: target.sessionID, variables }, { signal })
      current()
      try { await syncSessionGitContext(client, target.sessionID, signal) } catch { /* advisory only */ }
      await checkTarget()
      current()
      await client.session.synthetic({
        sessionID: target.sessionID, id: `msg_${stableToken(`${operation.id}\0resume\0${target.sessionID}`, 28)}`,
        text: target.sessionID === coordinatorID
          ? `Start or resume existing mission ${mission.id}. Inspect its map and playbook, use saved results, and continue coordination autonomously. Do not create a replacement mission. Resume existing queued assignments rather than duplicate them.`
          : `Resume your interrupted assignments in existing mission ${mission.id}. Inspect the mission map and your transcript first; continue unfinished work without repeating completed actions, then report normally.`,
        description: "CodeNomad mission start/resume", delivery: "queue", resume: true,
        metadata: { "codenomad.mission": { version: 1, missionID: mission.id, kind: "lifecycle", operationID: operation.id } },
      }, { signal })
    } else {
      current()
      await client.session.interrupt({ sessionID: target.sessionID, resume: false }, { signal })
      if (operation.action === "stop") {
        const inbox = await client.session.inbox.list({ sessionID: target.sessionID }, { signal })
        for (const item of inbox) {
          if (item.type !== "user" && item.type !== "synthetic") continue
          const metadata = item.payload.metadata?.["codenomad.mission"]
          if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || metadata.missionID !== mission.id) continue
          await checkTarget()
          current()
          try { await client.session.inbox.cancel({ sessionID: target.sessionID, inboxID: item.id }, { signal }) }
          catch (error) {
            if ((await client.session.inbox.list({ sessionID: target.sessionID }, { signal })).some(pending => pending.id === item.id)) throw error
          }
        }
      }
    }
    return { applied: true }
  } finally { release() }
}
