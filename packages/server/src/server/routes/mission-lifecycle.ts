import { isSessionNotFoundError } from "@opencode/client"
import { z } from "zod"
import { isDeepStrictEqual } from "node:util"
import { CODENOMAD_MISSIONS_RPC } from "../../missions/rpc"
import { controlResumeAdmissionID } from "../../missions/receipt-identity"
import { parseMissionNativeAcknowledgement } from "../../missions/lifecycle-schema"
import type { MissionLifecycleOperation, MissionNativeAcknowledgement } from "../../missions/lifecycle-model"
import type { MissionSnapshot } from "../../missions/model"
import { matchesExecution } from "../../missions/execution"
import { sameLocation, locationRequestOptions } from "../../opencode/compatibility/location"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { syncSessionGitContext } from "../../workspaces/session-git-context"
import { prepareMissionAuthority, assertMissionAuthorityCurrent, missionInstructionClient, type MissionAuthorityCheckpoint } from "./mission-authority-checkpoint"
import { interruptNativeMissionFamily, isSubagentDelivery, recheckNativeMissionFamily, settleInterruptedRoot, type NativeInboxItem } from "../../missions/native-family-interrupt"
import { readNativeControlFamily } from "../../missions/native-session-family"

/** Leaves headroom for the root interrupt inside the bridge's lifecycle timeout. */
const FAMILY_CONTROL_BUDGET_MS = 50_000
const FAMILY_RECHECK_BUDGET_MS = 10_000

const schema = z.object({ kind: z.literal("lifecycle"), input: z.object({
  missionID: z.string().min(1).max(100), operationID: z.string().min(1).max(100), sessionID: z.string().regex(/^ses_/).max(240),
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
    const checkOperation = async () => {
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
        || !latest.actors.some(actor => actor.sessionId === target.sessionID && sameLocation(actor.location, target.location))
        || fresh.missions.some(other => other.id !== mission.id && other.status === "active"
          && other.actors.some(actor => actor.sessionId === target.sessionID))) throw new Error("Mission control superseded")
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
        ? await interruptedConversations(client, await checkTarget(), mission.tasks, operation.pausedDescendants, signal, current) : ""
      await checkTarget()
      await checkCoordinator()
      await checkOperation()
      current()
      const admitted = await client.session.synthetic({
        sessionID: target.sessionID, id: controlResumeAdmissionID(operation.id, target.sessionID),
        text: target.sessionID === coordinatorID
          ? `Start or resume existing mission ${mission.id}. Inspect its map and playbook, use saved results, and continue coordination autonomously. Do not create a replacement mission. Resume existing queued assignments rather than duplicate them.${interrupted}`
          : `Resume your interrupted assignments in existing mission ${mission.id}. Inspect the mission map and your transcript first; continue unfinished work without repeating completed actions, then report normally.`,
        description: "CodeNomad mission start/resume", delivery: "queue", resume: true,
        metadata: { "codenomad.mission": { version: 1, missionID: mission.id, kind: "lifecycle", operationID: operation.id } },
      }, { signal })
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
      // Background subagents at any depth belong to this mission family. Stop
      // them deepest first before the root, best effort and honestly counted.
      const { descendants, ledger } = await interruptNativeMissionFamily({ client, root, action, signal, current, checkpoint,
        deadline: Date.now() + FAMILY_CONTROL_BUDGET_MS })
      await checkpoint()
      const interrupt = await client.session.interrupt({ sessionID: target.sessionID, resume: false }, { signal })
      current()
      if (!interrupt || typeof interrupt.interrupted !== "boolean" || Object.keys(interrupt).length !== 1) throw new Error("Unknown native interrupt acknowledgement")
      const cancellations: Array<{ inboxID: string; disposition: "native-acknowledged" | "observed-absent" }> = []
      // A stopped root must not be re-woken by its mission inputs or by the
      // cancelled results of its own native subagents.
      const cancellable = (item: NativeInboxItem) => {
        if (item.type !== "user" && item.type !== "synthetic") return false
        const metadata = item.payload.metadata?.["codenomad.mission"]
        return Boolean(metadata && typeof metadata === "object" && !Array.isArray(metadata) && metadata.missionID === mission.id)
          || isSubagentDelivery(item)
      }
      if (operation.action === "stop") {
        const inbox = await client.session.inbox.list({ sessionID: target.sessionID }, { signal })
        current()
        if (inbox.length > 128 || new Set(inbox.map(item => item.id)).size !== inbox.length) throw new Error("Incomplete native inbox observation")
        for (const item of inbox) {
          if (item.type !== "user" && item.type !== "synthetic") continue
          if (!cancellable(item)) continue
          await prepareMissionAuthority(authority)
          await checkTarget()
          await checkCoordinator()
          await checkOperation()
          current()
          try {
            const cancelled = await client.session.inbox.cancel({ sessionID: target.sessionID, inboxID: item.id }, { signal })
            current()
            if (cancelled !== undefined) throw new Error("Unknown native cancellation acknowledgement")
            cancellations.push({ inboxID: item.id, disposition: "native-acknowledged" })
          }
          catch (error) {
            current()
            const pending = await client.session.inbox.list({ sessionID: target.sessionID }, { signal })
            current()
            if (pending.length > 128 || new Set(pending.map(item => item.id)).size !== pending.length
              || pending.some(pending => pending.id === item.id)) throw error
            cancellations.push({ inboxID: item.id, disposition: "observed-absent" })
          }
        }
      }
      // The root ran until its interrupt and may have launched or queued work for
      // sub-agents after the family passes: interrupt them (and on Stop drain their
      // inboxes) before settling the root they re-wake, counted in the same ledger.
      const recheck = (control: typeof descendants, interrupt: boolean) => recheckNativeMissionFamily({ client, root, action, signal,
        current, checkpoint, deadline: Date.now() + FAMILY_RECHECK_BUDGET_MS }, ledger, control, interrupt)
      const caught = await recheck(descendants, true)
      // Pause leaves queued deliveries parked behind resume:false until Play.
      const settled = await settleInterruptedRoot({ client, root, action, signal, current, checkpoint,
        ...(action === "stop" ? { cancel: cancellable, onCancelled: (inboxID: string) => {
          if (cancellations.length < 128 && !cancellations.some(item => item.inboxID === inboxID)) cancellations.push({ inboxID, disposition: "native-acknowledged" })
        } } : {}) })
      // Only a whole, quiet family read after the root settled confirms a full stop.
      const verified = await recheck(caught, false)
      await checkTarget()
      await checkCoordinator()
      await checkOperation()
      const family = settled ? verified
        : { ...verified, unconfirmed: verified.unconfirmed + 1, complete: false }
      return reply({ ...ackIdentity, disposition: "interrupt-observed", interrupt, cancellations, descendants: family })
    }
  } finally { release() }
}

const MAX_LISTED_INTERRUPTIONS = 32

/** Descendant conversations the latest Pause interrupted that are still natively
 * interrupted, so the coordinator can decide what to re-delegate. User or older
 * interruptions are never attributed to that Pause. Advisory: a partial read or
 * receipt lists what it saw. */
async function interruptedConversations(client: Parameters<typeof readNativeControlFamily>[0], root: Parameters<typeof readNativeControlFamily>[1],
  tasks: MissionSnapshot["missions"][number]["tasks"], paused: NonNullable<MissionLifecycleOperation["pausedDescendants"]>,
  signal: AbortSignal, current: () => void): Promise<string> {
  if (!paused.sessions.length && !paused.partial) return ""
  const family = await readNativeControlFamily(client, root, signal, { assertCurrent: current, deadline: Date.now() + 15_000 })
  const ids = [...family.members.values()].filter(({ session }) => session.id !== root.id && session.outcome === "interrupted"
    && paused.sessions.includes(session.id)).map(({ session }) => session.id)
  if (!ids.length && !paused.partial) return ""
  if (!ids.length) return "\n\nThe mission was paused while sub-agents may have been running; inspect the mission map for unfinished delegated work."
  const listed = ids.slice(0, MAX_LISTED_INTERRUPTIONS).map(id => {
    const task = tasks.find(task => task.actorSessionId === id)
    return task ? `task ${task.key} (${id})` : id
  })
  const more = ids.length > listed.length ? ` and ${ids.length - listed.length} more` : ""
  const partial = family.complete && !paused.partial ? "" : " The sub-agent inventory was incomplete; inspect the mission map for others."
  return `\n\nThese sub-agent conversations were interrupted when the mission was paused: ${listed.join(", ")}${more}.`
    + ` Re-delegate or continue their unfinished tasks as needed; do not assume their work completed.${partial}`
}
