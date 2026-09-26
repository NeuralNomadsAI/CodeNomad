import type { WorkspaceManager } from "../workspaces/manager"
import { PluginControlsError } from "./plugin-controls"

type Manager = Pick<WorkspaceManager, "get" | "getSharedServiceConnection">
export type UsageQuery = { from: number; to: number; timezone: string }

// Deliberately service-wide, as authorized for the Usage Preferences surface.
// Native project IDs can span independent clones and are not physical Git-family
// authority. Never present this opaque aggregate as workspace/directory-scoped.
export class ServiceUsage {
  constructor(private readonly manager: Manager) {}
  async read(workspaceId: string, query: UsageQuery) {
    const record = this.manager.get(workspaceId)
    if (!record) throw new PluginControlsError("Workspace not found", "not-found")
    const connection = await this.manager.getSharedServiceConnection(workspaceId)
    if (!connection) throw new PluginControlsError("OpenCode connection unavailable", "unavailable")
    connection.assertCurrent()
    const stats = await connection.client.session.stats({ from: query.from, to: query.to, timezone: query.timezone, tools: "none" })
    connection.assertCurrent()
    if (this.manager.get(workspaceId) !== record) throw new PluginControlsError("Workspace connection changed", "forbidden")
    return { scope: "service" as const, stats }
  }
}
