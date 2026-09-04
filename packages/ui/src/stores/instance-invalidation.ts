export type InstanceRefreshTarget = "agents" | "providers" | "commands" | "metadata" | "filesystem"

export function getInstanceRefreshTargets(eventType: string): readonly InstanceRefreshTarget[] {
  switch (eventType) {
    case "agent.updated":
      return ["agents"]
    case "command.updated":
      return ["commands"]
    case "catalog.updated":
    case "models-dev.refreshed":
      return ["agents", "providers", "commands"]
    case "integration.updated":
    case "integration.connection.updated":
    case "credential.updated":
    case "credential.switched":
      return ["providers", "metadata"]
    case "config.updated":
      return ["agents", "providers", "commands", "metadata"]
    case "plugin.added":
    case "plugin.updated":
    case "mcp.status.changed":
    case "mcp.resources.changed":
      return ["metadata"]
    case "filesystem.changed":
      return ["filesystem"]
    case "vcs.branch.updated":
      return ["filesystem", "metadata"]
    default:
      return []
  }
}
