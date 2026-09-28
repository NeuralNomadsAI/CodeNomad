export type InstanceRefreshTarget = "agents" | "providers" | "commands" | "metadata" | "filesystem"

export function getInstanceRefreshTargets(eventType: string): readonly InstanceRefreshTarget[] {
  switch (eventType) {
    case "agent.updated":
      return ["agents"]
    case "command.updated":
      return ["commands"]
    case "models-dev.refreshed":
      return ["agents", "providers", "commands"]
    case "model.updated":
    case "provider.updated":
      return ["providers"]
    case "integration.updated":
    case "credential.updated":
    case "credential.switched":
      return ["providers", "metadata"]
    case "config.updated":
      return ["agents", "providers", "commands", "metadata"]
    case "plugin.updated":
      return ["agents", "providers", "commands"]
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
