import type { WorkspaceManager } from "../workspaces/manager"
import { readGitStatus } from "../workspaces/git-requirement"
import { PluginControlsError } from "./plugin-controls"

type Manager = Pick<WorkspaceManager, "get" | "getSharedServiceConnection" | "getServiceDirectoryForPath" | "ownsLocation">
export type UsageQuery = { directory: string; from: number; to: number; timezone: string }

// Native stats accepts a project, not a directory. Derive that project from the
// authorized native Location and require Git family authority before widening.
export class ProjectUsage {
  constructor(private readonly manager: Manager, private readonly gitStatus = readGitStatus) {}
  async read(workspaceId: string, query: UsageQuery) {
    const record = this.manager.get(workspaceId)
    if (!record) throw new PluginControlsError("Workspace not found", "not-found")
    if (!(await this.gitStatus()).available) throw new PluginControlsError("Project usage requires Git project authority", "unavailable")
    const connection = await this.manager.getSharedServiceConnection(workspaceId)
    if (!connection) throw new PluginControlsError("OpenCode connection unavailable", "unavailable")
    const directory = await this.manager.getServiceDirectoryForPath(workspaceId, query.directory)
    if (!directory) throw new PluginControlsError("Directory is not owned", "forbidden")
    connection.assertCurrent()
    const location = await connection.client.location.get({ location: { directory } })
    const projects = await connection.client.project.list()
    const project = projects.find(item => item.id === location.project.id && item.canonical === location.project.canonical)
    if (!project || project.vcs !== "git" || !await this.manager.ownsLocation(workspaceId, { directory: project.canonical }, connection.client)) {
      throw new PluginControlsError("Project is not owned", "forbidden")
    }
    connection.assertCurrent()
    const stats = await connection.client.session.stats({ project: project.id, from: query.from, to: query.to, timezone: query.timezone, tools: "none" })
    connection.assertCurrent()
    if (this.manager.get(workspaceId) !== record || !(await this.gitStatus()).available
      || !await this.manager.ownsLocation(workspaceId, { directory: project.canonical }, connection.client)) {
      throw new PluginControlsError("Project authority changed", "forbidden")
    }
    connection.assertCurrent()
    return { project: project.id, directory: project.canonical, stats }
  }
}
