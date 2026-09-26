import { z } from "zod"
import { isDeepStrictEqual } from "node:util"
import { CODENOMAD_MISSIONS_RPC } from "../../missions/rpc"
import type { MissionSnapshot } from "../../missions/model"
import { assignmentInput, reportInput } from "../../missions/inputs"
import { matchesExecution } from "../../missions/execution"
import { locationRequestOptions, sameLocation } from "../../opencode/compatibility/location"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"

const inputSchema = z.object({
  kind: z.enum(["prompt", "synthetic"]),
  input: z.object({
    sessionID: z.string().regex(/^ses/).max(240),
    id: z.string().regex(/^msg_/).max(240),
    text: z.string().min(1).max(100_000),
    description: z.string().max(240).optional(),
    metadata: z.object({ "codenomad.mission": z.object({
      version: z.literal(1), missionID: z.string().max(100), kind: z.enum(["assignment", "report"]),
      taskKey: z.string().max(100), role: z.string().max(100).optional(),
      reportID: z.string().max(100).optional(), fromSessionID: z.string().max(240).optional(),
    }).strict() }).strict(),
    delivery: z.enum(["queue", "steer"]), resume: z.literal(true),
  }).strict(),
}).strict()

type Manager = Pick<WorkspaceManager, "list" | "getSharedServiceConnection" | "ownsLocation" | "getWorktreeIdentityForPath" | "getSessionEnvironment">

// Called only behind the loopback token-authenticated desktop bridge. No environment
// values leave this backend; both native writes share ownership, connection and fence.
export async function admitMissionInput(manager: Manager, fence: WorktreeDeletionFence, coordinatorID: string, command: unknown, signal: AbortSignal) {
  const { kind, input } = inputSchema.parse(command)
  const owners = []
  for (const workspace of manager.list()) {
    const connection = await manager.getSharedServiceConnection(workspace.id)
    if (!connection) continue
    const coordinator = await connection.client.session.get({ sessionID: coordinatorID })
    const target = await connection.client.session.get({ sessionID: input.sessionID })
    if (await manager.ownsLocation(workspace.id, coordinator.location, connection.client)
      && await manager.ownsLocation(workspace.id, target.location, connection.client)) owners.push({ workspace, connection, coordinator, target })
  }
  // Duplicate logical tabs in one backend share the profile; bridge discovery
  // already rejects multiple backends that could supply different profiles.
  if (!owners.length) throw new Error("Missing mission owner")
  const { workspace, connection, coordinator, target } = owners[0]
  const client = connection.client
  if (coordinator.parentID || target.parentID || coordinator.projectID !== target.projectID
    || !await manager.ownsLocation(workspace.id, target.location, client)) throw new Error("Foreign mission actor")
  const snapshot = await client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, {
    location: { directory: coordinator.location.directory }, ...locationRequestOptions(coordinator.location), signal,
  }) as MissionSnapshot
  const metadata = input.metadata["codenomad.mission"]
  const mission = snapshot.missions.find(mission => mission.id === metadata.missionID)
  if (snapshot.projectID !== coordinator.projectID || !mission || mission.coordinatorSessionId !== coordinatorID) {
    throw new Error("Foreign mission contract")
  }
  const task = mission.tasks.find(task => task.key === metadata.taskKey)
  if (!task) throw new Error("Missing mission task")
  const expected = kind === "prompt" && mission.status === "active" && task.status === "dispatching"
    ? assignmentInput(mission, task)
    : kind === "synthetic" && task.report ? reportInput(mission, task.report) : undefined
  if (!expected || !isDeepStrictEqual(input, expected)) throw new Error("Mission input differs from its durable contract")
  if (kind === "prompt" && !matchesExecution(task.execution, target)) throw new Error("Mission execution selection changed")
  const identities = await Promise.all([target, coordinator].map(session =>
    manager.getWorktreeIdentityForPath(workspace.id, session.location.directory)))
  if (identities.some(identity => !identity)) throw new Error("Missing mission worktree")
  const release = fence.enter(identities as string[])
  if (!release) throw new Error("Worktree deletion in progress")
  try {
    signal.throwIfAborted()
    connection.assertCurrent()
    const variables = await manager.getSessionEnvironment(workspace.id, signal)
    const currentTarget = await client.session.get({ sessionID: target.id }, { signal })
    const currentCoordinator = await client.session.get({ sessionID: coordinatorID }, { signal })
    if (!sameLocation(currentTarget.location, target.location) || !sameLocation(currentCoordinator.location, coordinator.location)
      || currentTarget.parentID || currentCoordinator.parentID
      || currentTarget.projectID !== target.projectID || currentCoordinator.projectID !== coordinator.projectID
      || (kind === "prompt" && !matchesExecution(task.execution, currentTarget))) throw new Error("Mission sessions changed during admission")
    signal.throwIfAborted()
    connection.assertCurrent()
    await client.session.environment({ sessionID: target.id, variables }, { signal })
    signal.throwIfAborted()
    connection.assertCurrent()
    if (kind === "prompt") await client.session.prompt(input, { signal })
    else await client.session.synthetic(input, { signal })
    return { admitted: true }
  } finally { release() }
}
