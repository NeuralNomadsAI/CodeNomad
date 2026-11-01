import { isSessionNotFoundError } from "@opencode/client"
import { z } from "zod"
import { isDeepStrictEqual } from "node:util"
import { CODENOMAD_MISSIONS_RPC } from "../../missions/rpc"
import { parseMissionNativeAcknowledgement } from "../../missions/lifecycle-schema"
import type { MissionNativeAcknowledgement } from "../../missions/lifecycle-model"
import type { MissionSnapshot } from "../../missions/model"
import { matchesExecution } from "../../missions/execution"
import { sameLocation, locationRequestOptions } from "../../opencode/compatibility/location"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { syncSessionGitContext } from "../../workspaces/session-git-context"
import { prepareMissionAuthority, assertMissionAuthorityCurrent, missionInstructionClient, type MissionAuthorityCheckpoint } from "./mission-authority-checkpoint"
import { interruptNativeMissionActor, interruptedMissionConversations, missionActorResumeInput } from "../../missions/native-actor-lifecycle"
import { MISSION_LIFECYCLE_TEXT_LIMIT } from "../../missions/lifecycle-input"
import { stableToken } from "../../missions/receipt-identity"

const schema = z.object({ kind: z.literal("lifecycle"), input: z.object({
  missionID: z.string().min(1).max(100), operationID: z.string().min(1).max(100), sessionID: z.string().regex(/^ses_/).max(240),
  startText: z.string().min(1).max(MISSION_LIFECYCLE_TEXT_LIMIT).optional(),
}).strict() }).strict()
type Manager = Pick<WorkspaceManager, "list" | "getSharedServiceConnection" | "ownsLocation" | "getWorktreeIdentityForPath" | "getSessionEnvironment">

export async function applyMissionLifecycle(manager: Manager, fence: WorktreeDeletionFence, coordinatorID: string, command: unknown, signal: AbortSignal,
  authority?: MissionAuthorityCheckpoint) {
  const { input } = schema.parse(command)
  const owner = await Promise.any(manager.list().map(async workspace => {
    const connection = await manager.getSharedServiceConnection(workspace.id)
    if (!connection) throw new Error("Workspace unavailable")
    const coordinator = await connection.client.session.get({ sessionID: coordinatorID }, { signal })
    if (coordinator.id !== coordinatorID || coordinator.parentID || !await manager.ownsLocation(workspace.id, coordinator.location, connection.client)) throw new Error("Foreign coordinator")
    return { connection, workspace, coordinator }
  })).catch(() => undefined)
  if (!owner) throw new Error("Missing mission owner")
  const { connection, workspace, coordinator } = owner
  const client = connection.client
  const snapshot = await client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, {
    location: { directory: coordinator.location.directory }, ...locationRequestOptions(coordinator.location), signal,
  }) as MissionSnapshot
  const savedMission = snapshot.missions.find(mission => mission.id === input.missionID)
  const mission = savedMission && structuredClone(savedMission)
  const operation = mission?.control
  const target = operation?.targets.find(target => target.sessionID === input.sessionID)
  if (!mission || snapshot.projectID !== coordinator.projectID || mission.projectID !== coordinator.projectID
    || mission.coordinatorSessionId !== coordinatorID || !operation || operation.id !== input.operationID || !target
    || !operation.pending.includes(target.sessionID)) throw new Error("No pending mission control authority")
  const inputDigest = mission.document?.firstPlay?.operationID === operation.id ? mission.document.firstPlay.inputDigest : undefined
  if (inputDigest !== undefined || input.startText !== undefined) {
    if (operation.action !== "start" || target.sessionID !== coordinatorID || input.startText === undefined
      || inputDigest !== stableToken(input.startText, 64)) throw new Error("Frozen Mission launch context differs")
  }
  const targetActor = mission.actors.find(actor => actor.sessionId === target.sessionID)
  if (!targetActor || !sameLocation(targetActor.location, target.location)
    || !await manager.ownsLocation(workspace.id, target.location, client)) throw new Error("Foreign mission actor")
  // A stopped/finished mission's actor may since serve another active mission (an
  // explicitly reused root). Stop then settles without touching it; any other
  // control on a shared actor is refused.
  const sharedIn = (current: MissionSnapshot) => current.missions.some(other => other.id !== mission.id && other.status === "active"
    && other.actors.some(actor => actor.sessionId === target.sessionID))
  if (sharedIn(snapshot) && operation.action !== "stop") throw new Error("Mission actor is shared")
  const expectedState = operation.action === "start" ? "running" : operation.action === "pause" ? "paused" : "stopped"
  if (mission.runState !== expectedState || (operation.action !== "stop" && mission.status !== "active")) throw new Error("Mission control superseded")
  const identities = await Promise.all([coordinator.location, target.location].map(location => manager.getWorktreeIdentityForPath(workspace.id, location.directory)))
  if (identities.some(identity => !identity)) throw new Error("Missing mission worktree")
  const release = fence.enter(identities as string[])
  if (!release) throw new Error("Worktree mutation in progress")
  const current = () => { signal.throwIfAborted(); connection.assertCurrent(); assertMissionAuthorityCurrent(authority) }
  try {
    await prepareMissionAuthority(authority)
    current()
    const ackIdentity = { missionID: mission.id, operationID: operation.id, sessionID: target.sessionID, action: operation.action }
    const reply = (value: unknown): { nativeAcknowledgement: MissionNativeAcknowledgement } => {
      current()
      const nativeAcknowledgement = parseMissionNativeAcknowledgement(value, ackIdentity)
      if (!nativeAcknowledgement) throw new Error("Unknown native control acknowledgement")
      return { nativeAcknowledgement }
    }
    const checkOperation = async (allowShared = false) => {
      current()
      const fresh = await client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, {
        location: { directory: coordinator.location.directory }, ...locationRequestOptions(coordinator.location), signal,
      }) as MissionSnapshot
      current()
      const latest = fresh.missions.find(item => item.id === mission.id)
      if (fresh.controlUnavailable || fresh.projectID !== mission.projectID || !latest || latest.controlUnavailable
        || latest.projectID !== mission.projectID || latest.coordinatorSessionId !== coordinatorID
        || latest.control?.id !== operation.id || latest.control.action !== operation.action
        || latest.control.requestID !== operation.requestID || latest.control.expectedRevision !== operation.expectedRevision
        || !isDeepStrictEqual(latest.control.targets, operation.targets) || !latest.control.pending.includes(target.sessionID)
        || latest.runState !== expectedState || (operation.action !== "stop" && latest.status !== "active")
        || latest.document?.firstPlay?.inputDigest !== mission.document?.firstPlay?.inputDigest
        || !latest.actors.some(actor => actor.sessionId === target.sessionID && sameLocation(actor.location, target.location))
        || !allowShared && sharedIn(fresh)) throw new Error("Mission control superseded")
      return fresh
    }
    const checkTarget = async () => {
      const session = await client.session.get({ sessionID: target.sessionID }, { signal })
      current()
      if (session.id !== target.sessionID || session.parentID || session.projectID !== mission.projectID || !sameLocation(session.location, target.location)
        || !await manager.ownsLocation(workspace.id, session.location, client)) throw new Error("Mission actor moved")
      current()
      if (operation.action === "start" && mission.tasks.some(task => task.actorSessionId === session.id
        && (task.status === "queued" || task.status === "dispatching") && !matchesExecution(task.execution, session))) throw new Error("Actor selection changed")
      return session
    }
    const checkCoordinator = async () => {
      const freshCoordinator = await client.session.get({ sessionID: coordinatorID }, { signal })
      current()
      if (freshCoordinator.id !== coordinatorID || freshCoordinator.parentID || freshCoordinator.projectID !== coordinator.projectID || !sameLocation(freshCoordinator.location, coordinator.location)
        || !await manager.ownsLocation(workspace.id, freshCoordinator.location, client)) throw new Error("Coordinator moved")
      current()
    }
    if (operation.action === "stop" && sharedIn(await checkOperation(true))) {
      // No native effect: interrupting or draining it would stop the other mission.
      await checkCoordinator()
      if (!sharedIn(await checkOperation(true))) throw new Error("Mission control superseded")
      return reply({ ...ackIdentity, disposition: "target-reused" })
    }
    await checkOperation()
    try { await checkTarget() }
    catch (error) {
      if (operation.action !== "start" && isSessionNotFoundError(error) && error.sessionID === target.sessionID) {
        await checkCoordinator()
        await checkOperation()
        return reply({ ...ackIdentity, disposition: "target-missing" })
      }
      throw error
    }
    await checkCoordinator()
    if (operation.action === "start") {
      const variables = await manager.getSessionEnvironment(workspace.id, signal)
      await prepareMissionAuthority(authority)
      await checkTarget()
      await checkCoordinator()
      await checkOperation()
      current()
      await client.session.environment({ sessionID: target.sessionID, variables }, { signal })
      current()
      try { await syncSessionGitContext(missionInstructionClient(client, authority), target.sessionID, signal) } catch { /* advisory only */ }
      await prepareMissionAuthority(authority)
      await checkTarget()
      await checkCoordinator()
      await checkOperation()
      current()
      const interrupted = target.sessionID === coordinatorID && operation.pausedDescendants
          ? await interruptedMissionConversations(client, await checkTarget(), mission.tasks, operation.pausedDescendants, signal, current) : ""
      await checkTarget()
      await checkCoordinator()
      await checkOperation()
      current()
      const route = missionActorResumeInput(mission.id, operation.id, target.sessionID, coordinatorID, interrupted)
      const admitted = await client.session.synthetic({ ...route, ...(input.startText === undefined ? {} : { text: input.startText }) }, { signal })
      current()
      await checkTarget()
      await checkCoordinator()
      await checkOperation()
      return reply({ ...ackIdentity, disposition: "start-admitted", admission: admitted })
    } else {
      const action = operation.action
      const checkpoint = async () => {
        await prepareMissionAuthority(authority)
        await checkTarget()
        await checkCoordinator()
        await checkOperation()
        current()
      }
      await checkpoint()
      const root = await checkTarget()
      current()
      const observed = await interruptNativeMissionActor({ client, root, action, missionID: mission.id, signal, current, checkpoint })
      await checkTarget()
      await checkCoordinator()
      await checkOperation()
      return reply({ ...ackIdentity, disposition: "interrupt-observed", ...observed })
    }
  } finally { release() }
}
