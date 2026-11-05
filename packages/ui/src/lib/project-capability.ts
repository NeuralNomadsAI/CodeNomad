import type { Instance } from "../types/instance"
import type { ServerCapability } from "../../../server/src/opencode/servers/capabilities"

// prototype-1236: UI-only host surfaces. A local project has them; an explicit server never does:
// host Git (history, index, commit, init, forge), file writes and plugin configuration writes.
type HostOnlyFeature = "hostGit" | "fileWrite" | "pluginWrite"
export type ProjectFeature = ServerCapability | HostOnlyFeature
export type ProjectAvailability = { allowed: boolean }

const hostOnly = new Set<ProjectFeature>(["hostGit", "fileWrite", "pluginWrite"])
const deferred = new Set<ProjectFeature>(["worktrees", "terminal", "missions",
  "sessionPruning", "automation", "design", "integratedImages", "conversationDiffs", "serviceManagement",
  "executionSettings", "historyEnrichment", ...hostOnly])

/** UI policy consumes the source occurrence, never the selected global tab or an URL. */
export function projectAvailability(source: Instance | undefined, feature: ProjectFeature, metadataCurrent = false): ProjectAvailability {
  const unknown = { allowed: false }
  if (!source || !source.id || typeof source.folder !== "string" || !source.folder || source.folder.includes("\0")) return unknown
  const serverId = source.binding?.serverId ?? source.renderBinding?.serverId ?? source.capabilities?.serverId ?? "local-shared"
  if (source.binding && (typeof source.binding.serverId !== "string" || !source.binding.serverId
    || typeof source.binding.directory !== "string" || !source.binding.directory || source.binding.directory.includes("\0"))) return unknown
  if (source.renderBinding && (source.renderBinding.serverId !== serverId
    || source.renderBinding.folder !== source.folder
    || (source.binding && source.renderBinding.directory !== source.binding.directory))) return unknown
  const capabilities = source.capabilities
  if (capabilities && capabilities.serverId !== serverId) return unknown
  if (serverId === "local-shared") {
    const status = hostOnly.has(feature) ? undefined : capabilities?.features?.[feature as ServerCapability]
    return !status || status.state === "unknown" || status.state === "available"
      ? { allowed: true } : unknown
  }
  if (!source.binding || !capabilities || !metadataCurrent || !Number.isSafeInteger(capabilities.generation) || capabilities.generation < 1) return unknown
  // Product-delivery policy is independent of native metadata: an injected
  // `available` can never grant a host reader, bridge or deferred integration.
  if (deferred.has(feature)) return unknown
  const status = capabilities.features?.[feature as ServerCapability]
  if (!status || !["contractUnverified", "contractVerified", "liveOnly", "deferred", "localOnly"].includes(status.reason?.code)) return unknown
  return status?.state === "available" ? { allowed: true } : unknown
}
