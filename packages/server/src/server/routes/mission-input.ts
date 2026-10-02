import { z } from "zod"
import { isDeepStrictEqual } from "node:util"
import { CODENOMAD_MISSIONS_RPC } from "../../missions/rpc"
import type { MissionSnapshot } from "../../missions/model"
import { assignmentInput, reportInput } from "../../missions/inputs"
import { matchesExecution } from "../../missions/execution"
import { locationRequestOptions, sameLocation } from "../../opencode/compatibility/location"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { syncSessionGitContext } from "../../workspaces/session-git-context"
import { cleanupMissionSession } from "./mission-cleanup"
import { applyMissionLifecycle } from "./mission-lifecycle"
import { missionIsRunning } from "../../missions/lifecycle-model"
import type { ProviderAccountsService } from "../../provider-accounts/service"

const inputSchema = z.object({
  kind: z.enum(["prompt", "synthetic"]),
  input: z.object({
    sessionID: z.string().regex(/^ses/).max(240),
    id: z.string().regex(/^msg_/).max(240),
    // Objective + brief (20k each) and title (240) can expand 5x in XML.
    // Leave room for role instructions/dependencies. The bridge also bounds the
    // JSON wire body at 512 KiB, including worst-case control-character escapes.
    text: z.string().min(1).max(250_000),
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
export async function admitMissionInput(manager: Manager, fence: WorktreeDeletionFence, coordinatorID: string, command: unknown, signal: AbortSignal, accounts?: ProviderAccountsService) {
  if (command && typeof command === "object" && "kind" in command && command.kind === "lifecycle") {
    return applyMissionLifecycle(manager, fence, coordinatorID, command, signal)
  }
  if (command && typeof command === "object" && "kind" in command && command.kind === "cleanup") {
    return cleanupMissionSession(manager, fence, coordinatorID, command, signal)
  }
  const { kind, input } = inputSchema.parse(command)
  const owner = await Promise.any(manager.list().map(async workspace => {
    const connection = await manager.getSharedServiceConnection(workspace.id)
    if (!connection) throw new Error("Workspace is not ready")
    const coordinator = await connection.client.session.get({ sessionID: coordinatorID })
    const target = await connection.client.session.get({ sessionID: input.sessionID })
    if (await manager.ownsLocation(workspace.id, coordinator.location, connection.client)
      && await manager.ownsLocation(workspace.id, target.location, connection.client)) return { workspace, connection, coordinator, target }
    throw new Error("Not a mission owner")
  })).catch(() => undefined)
  // Duplicate logical tabs in one backend share the profile; bridge discovery
  // already rejects multiple backends that could supply different profiles.
  if (!owner) throw new Error("Missing mission owner")
  const { workspace, connection, coordinator, target } = owner
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
  if (!missionIsRunning(mission)) throw new Error("Mission is not running")
  const task = mission.tasks.find(task => task.key === metadata.taskKey)
  if (!task) throw new Error("Missing mission task")
  const report = task.report?.id === metadata.reportID
    ? task.report
    : task.lateReports?.find(candidate => candidate.id === metadata.reportID)
  const expected = kind === "prompt" && mission.status === "active" && task.status === "dispatching"
    ? assignmentInput(mission, task)
    : kind === "synthetic" && report ? reportInput(mission, report) : undefined
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
    try {
      await syncSessionGitContext(client, target.id, signal)
    } catch {
      // Git context is advisory; never expose SDK bodies or block on its failure.
    }
    signal.throwIfAborted()
    connection.assertCurrent()
    if (kind === "prompt") {
      await accounts?.beforeSend(connection, target.id, AbortSignal.any([signal, AbortSignal.timeout(15_000)]), async () => {
        const current = await client.session.get({ sessionID: target.id }, { signal })
        return sameLocation(current.location, target.location) && matchesExecution(task.execution, current)
          && await manager.ownsLocation(workspace.id, current.location, client)
      })
      signal.throwIfAborted(); connection.assertCurrent()
      await client.session.prompt(input, { signal })
    }
    else await client.session.synthetic(input, { signal })
    return { admitted: true }
  } finally { release() }
}
