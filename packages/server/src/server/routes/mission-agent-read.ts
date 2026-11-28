import { z } from "zod"
import { parseProjectRead } from "../../missions/project-read-tool"
import { missionPanelPageRequestSchema, missionPanelBytes, MISSION_PANEL_PAGE_BYTES } from "../../missions/mission-panel-page"
import { isReservedMissionScheduleSessionID } from "../../missions/mission-schedule-carrier-identity"
import { getLocalGitBranches } from "../../workspaces/git-branches"
import { sameLocation } from "../../opencode/compatibility/location"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import type { ForgeWorkItems } from "../../forge/work-items"
import { prepareMissionMapMutation } from "./mission-map-mutation"
import { ownedMissionAgent } from "./mission-agent-owner"
import { missionPlaybookDetails } from "../../missions/recipes"

type Deps = { workspaceManager: WorkspaceManager; worktreeDeletionFence?: WorktreeDeletionFence;
  forge?: Pick<ForgeWorkItems, "openRepository"> }

/** Fixed read-only native methods; project identity and physical scope surround every read. */
export async function readAgentMissionProject(deps: Deps, sessionID: string, raw: unknown, signal: AbortSignal) {
  const command = z.object({ kind: z.literal("project-read"), input: z.unknown() }).strict().parse(raw)
  const input = parseProjectRead(command.input), manager = deps.workspaceManager
  const agent = await ownedMissionAgent(manager, sessionID, signal)
  const { client, workspace, options, session, refresh } = agent
  if (input.kind === "playbook") {
    const details = missionPlaybookDetails(input.taskMode)
    const result = { taskMode: details.taskMode, playbook: details.playbooks.find(item => item.id === input.template)! }
    await refresh()
    if (JSON.stringify(result, null, 2).length > 100_000) throw new Error("Mission playbook read capacity")
    return result
  }
  const owned = await prepareMissionMapMutation({ manager, fence: deps.worktreeDeletionFence, workspaceID: workspace.id,
    directory: session.location.directory, signal })
  return owned.run(async (rpc, call) => {
    const current = async () => { await owned.refresh(); await refresh() }
    await current()
    if (input.kind === "sources") {
      if (input.source === "conversations" || input.source === "coordinators") {
        const page = await client.session.list(input.cursor ? { cursor: input.cursor } : {
          directory: options.location.directory, limit: 50, order: "desc", search: input.search,
          ...(input.source === "coordinators" ? { parentID: null } : {}),
        }, { signal })
        await current()
        if (page.data.length > 50) throw new Error("Conversation source page capacity")
        const data = page.data.filter(row => !isReservedMissionScheduleSessionID(row.id) && row.projectID === session.projectID
          && sameLocation(row.location, session.location) && (input.source !== "coordinators" || !row.parentID))
        return { sources: data.map(row => ({ id: row.id, title: row.title })), next: page.cursor.next }
      }
      const host = await manager.getHostPathForServicePath(workspace.id, options.location.directory)
      if (!host) throw new Error("Source directory unavailable")
      const result = input.source === "branches" ? { branches: await getLocalGitBranches(host) }
        : await (async () => {
          if (!deps.forge) throw new Error("Repository source unavailable")
          const value = await deps.forge.openRepository(host, true, signal)
          return value.status === "ok" ? { status: "ok", repository: { provider: value.repository.provider,
            host: value.repository.host, repository: value.repository.path } } : value
        })()
      await current()
      return result
    }
    const value = await rpc.panelPage(missionPanelPageRequestSchema.parse(input.input), call)
    await current()
    if (missionPanelBytes(value) > MISSION_PANEL_PAGE_BYTES) throw new Error("Mission project read capacity")
    const result = value as { available?: boolean; projectID?: string; projectCanonical?: string; location?: { directory: string } }
    if (result.available !== false && result.projectID !== session.projectID
      || result.projectCanonical !== undefined && result.projectCanonical !== agent.project.canonical
      || result.location && !sameLocation(result.location, session.location)) throw new Error("Foreign Mission project read")
    return value
  })
}
