import { z } from "zod"
import type { OpenCodeClient, SessionInfo } from "@opencode/client"
import { CODENOMAD_MISSIONS_RPC } from "../../missions/rpc"
import type { MissionMap, MissionSnapshot, MissionTask } from "../../missions/model"
import { MissionControlError } from "../../missions/control-error"
import { parseMissionChildTaskKey } from "../../missions/task-sessions"
import { interruptNativeMissionFamily, settleInterruptedRoot, type MissionDescendantControl } from "../../missions/native-family-interrupt"
import { locationRequestOptions, sameLocation } from "../../opencode/compatibility/location"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"

/** Direct coordinator children examined per call; more is an honest partial result. */
const CHILD_BOUND = 200
const CHILD_PAGE = 100
/** Leaves headroom inside the bridge's lifecycle timeout. */
const INTERRUPT_BUDGET_MS = 50_000

const taskCommand = (kind: "task-sessions" | "interrupt") => z.object({ kind: z.literal(kind), input: z.object({
  missionID: z.string().min(1).max(100), taskKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/),
}).strict() }).strict()

type Manager = Pick<WorkspaceManager, "list" | "getSharedServiceConnection" | "ownsLocation" | "getWorktreeIdentityForPath">

/** Advisory native evidence, never task settlement or execution proof. */
export interface MissionTaskSessions {
  sessions: Array<{ sessionID: string; active: boolean }>
  /** False when the child inventory was bounded or a first message was unreadable. */
  complete: boolean
}

export interface MissionTaskInterruption {
  sessions: Array<{ sessionID: string; interrupted: boolean; settled: boolean; descendants: MissionDescendantControl }>
  /** Every task conversation found, interrupted and confirmed quiet with its whole family. */
  complete: boolean
}

async function ownedTask(manager: Manager, coordinatorID: string, command: unknown, kind: "task-sessions" | "interrupt", signal: AbortSignal) {
  const { input } = taskCommand(kind).parse(command)
  const owner = await Promise.any(manager.list().map(async workspace => {
    const connection = await manager.getSharedServiceConnection(workspace.id)
    if (!connection) throw new Error("Workspace unavailable")
    const coordinator = await connection.client.session.get({ sessionID: coordinatorID }, { signal })
    if (coordinator.id !== coordinatorID || coordinator.parentID
      || !await manager.ownsLocation(workspace.id, coordinator.location, connection.client)) throw new Error("Foreign coordinator")
    return { connection, workspace, coordinator }
  })).catch(() => undefined)
  if (!owner) throw new Error("Missing mission owner")
  const { connection, workspace, coordinator } = owner
  const client = connection.client
  const read = async (): Promise<{ mission: MissionMap; task: MissionTask }> => {
    const snapshot = await client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, {
      location: { directory: coordinator.location.directory }, ...locationRequestOptions(coordinator.location), signal,
    }) as MissionSnapshot
    const mission = snapshot.missions.find(mission => mission.id === input.missionID)
    const task = mission?.tasks.find(task => task.key === input.taskKey)
    if (!mission || !task || snapshot.projectID !== coordinator.projectID || mission.projectID !== coordinator.projectID
      || mission.coordinatorSessionId !== coordinatorID) throw new Error("Foreign mission task")
    // Without a published binding only the coordinator's own children carry the assignment.
    if (task.executionMode?.kind !== "native" || task.executionMode.parentTaskKey !== null) {
      throw new MissionControlError("Only native tasks launched by the coordinator have observable conversations", "task-sessions-unavailable")
    }
    return { mission, task }
  }
  return { client, connection, workspace, coordinator, read, ...await read() }
}

/** The coordinator's direct children whose first user message carries this task's
 * canonical assignment header (exact mission ID and task key, never titles or timing). */
async function readTaskSessions(client: OpenCodeClient, coordinator: SessionInfo, mission: MissionMap, task: MissionTask,
  signal: AbortSignal, current: () => void): Promise<MissionTaskSessions & { roots: SessionInfo[] }> {
  const roots: SessionInfo[] = [], cursors = new Set<string>(), keys = new Set([task.key])
  let complete = true, listed = 0, cursor: string | undefined
  do {
    const page = await client.session.list({ parentID: coordinator.id, limit: CHILD_PAGE, ...(cursor ? { cursor } : {}) }, { signal })
    current()
    for (const child of page.data) {
      if (++listed > CHILD_BOUND) { complete = false; break }
      if (child.parentID !== coordinator.id || child.projectID !== coordinator.projectID || !sameLocation(child.location, coordinator.location)) {
        complete = false
        continue
      }
      let first: unknown
      try { first = (await client.message.list({ sessionID: child.id, limit: 1, order: "asc", type: "user" }, { signal })).data[0] }
      catch { signal.throwIfAborted(); complete = false; continue }
      current()
      if (first !== undefined && parseMissionChildTaskKey(mission.id, first, keys) === task.key) roots.push(child)
    }
    if (listed > CHILD_BOUND) break
    // Native emits next for every nonempty page: drain until the empty end page.
    cursor = page.cursor.next ?? undefined
    if (cursor && (!page.data.length || cursors.has(cursor))) { complete = false; cursor = undefined }
    if (cursor) cursors.add(cursor)
  } while (cursor)
  const active = roots.length ? await client.session.active({ signal }) : {}
  current()
  return { roots, complete, sessions: roots.map(root => ({ sessionID: root.id, active: Boolean(active[root.id]) })) }
}

export async function observeMissionTask(manager: Manager, coordinatorID: string, command: unknown, signal: AbortSignal): Promise<MissionTaskSessions> {
  const owned = await ownedTask(manager, coordinatorID, command, "task-sessions", signal)
  const current = () => { signal.throwIfAborted(); owned.connection.assertCurrent() }
  const { sessions, complete } = await readTaskSessions(owned.client, owned.coordinator, owned.mission, owned.task, signal, current)
  return { sessions, complete }
}

/** Stops a retired native task's own conversations and their whole native families,
 * deepest first, then cancels their queued inputs. The coordinator is never touched. */
export async function interruptMissionTask(manager: Manager, fence: WorktreeDeletionFence, coordinatorID: string, command: unknown,
  signal: AbortSignal): Promise<MissionTaskInterruption> {
  const owned = await ownedTask(manager, coordinatorID, command, "interrupt", signal)
  const { client, connection, workspace, coordinator } = owned
  const retired = (mission: MissionMap, task: MissionTask) => mission.status === "active" && task.status === "withdrawn"
  if (!retired(owned.mission, owned.task)) throw new MissionControlError("Retire the task with mission.revise before stopping its work", "task-not-retired")
  const identity = await manager.getWorktreeIdentityForPath(workspace.id, coordinator.location.directory)
  if (!identity) throw new Error("Missing mission worktree")
  const release = fence.enter([identity])
  if (!release) throw new Error("Worktree mutation in progress")
  const current = () => { signal.throwIfAborted(); connection.assertCurrent() }
  const checkpoint = async () => {
    current()
    const { mission, task } = await owned.read()
    if (!retired(mission, task)) throw new MissionControlError("Retire the task with mission.revise before stopping its work", "task-not-retired")
    const fresh = await client.session.get({ sessionID: coordinatorID }, { signal })
    if (fresh.id !== coordinatorID || fresh.parentID || !sameLocation(fresh.location, coordinator.location)
      || !await manager.ownsLocation(workspace.id, fresh.location, client)) throw new Error("Coordinator moved")
    current()
  }
  try {
    const deadline = Date.now() + INTERRUPT_BUDGET_MS
    const found = await readTaskSessions(client, coordinator, owned.mission, owned.task, signal, current)
    const sessions: MissionTaskInterruption["sessions"] = []
    for (const root of found.roots) {
      await checkpoint()
      const { descendants } = await interruptNativeMissionFamily({ client, root, action: "stop", signal, current, checkpoint, deadline })
      await checkpoint()
      const interrupt = await client.session.interrupt({ sessionID: root.id, resume: false }, { signal })
      current()
      // Retired work must not be re-woken by its own queued inputs or helper results.
      const settled = await settleInterruptedRoot({ client, root, action: "stop", signal, current, checkpoint, cancel: () => true })
      sessions.push({ sessionID: root.id, interrupted: interrupt?.interrupted === true, settled, descendants })
    }
    return { sessions, complete: found.complete && sessions.every(session => session.settled && session.descendants.complete) }
  } finally { release() }
}
