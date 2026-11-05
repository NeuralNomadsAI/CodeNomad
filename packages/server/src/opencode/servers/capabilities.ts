import type { OpenCodeServerId, OpenCodeServerProfile, ServerConnectionGeneration } from "./types"

export const SERVER_CAPABILITY_NAMES = [
  "sessions", "chat", "media", "permissions", "questions", "events", "pendingRecovery",
  "conversationDiffs", "files", "git", "worktrees", "terminal", "backgroundShells",
  "missions", "automation", "sessionPruning", "design", "sessionEnvironment", "serviceManagement",
  "historyEnrichment", "integratedImages", "executionSettings",
  // prototype-1236: execution settings an explicit server serves natively (auto-accept, published quotas, plugin inventory).
  "yolo", "providerUsage", "plugins",
] as const
export type ServerCapability = typeof SERVER_CAPABILITY_NAMES[number]
export type ServerCapabilityReason = "contractUnverified" | "contractVerified" | "liveOnly" | "deferred" | "localOnly"
export interface ServerCapabilityStatus {
  state: "available" | "limited" | "unavailable" | "unknown"
  reason: { code: ServerCapabilityReason }
  evidence: "unverified" | "nativeContract" | "e1Policy"
}
export interface ServerCapabilities {
  serverId: OpenCodeServerId
  generation: ServerConnectionGeneration
  features: Record<ServerCapability, ServerCapabilityStatus>
}

export class WorkspaceCapabilityError extends Error {
  readonly code = "explicit_capability_unavailable"
  constructor(readonly capability: ServerCapability, readonly reason: { code: ServerCapabilityReason }) {
    super("explicit_capability_unavailable")
    this.name = "WorkspaceCapabilityError"
  }
}

/** Product policy gate. Call with owner-held authority, never a published descriptor. */
export function requireServerCapability(capability: ServerCapability, status: ServerCapabilityStatus, local = false): void {
  if (status.state === "available" || (local && status.state === "unknown")) return
  throw new WorkspaceCapabilityError(capability, { code: status.reason.code })
}

/** E1 explicit policy template; admission must qualify native contracts before availability. */
export function initialServerCapabilities(profile: OpenCodeServerProfile, generation: ServerConnectionGeneration): ServerCapabilities {
  const native = new Set<ServerCapability>(["sessions", "chat", "media", "permissions", "questions", "events"])
  const features = Object.fromEntries(SERVER_CAPABILITY_NAMES.map(name => [name,
    profile.kind === "local-shared" || native.has(name) ? { state: "unknown", reason: { code: "contractUnverified" }, evidence: "unverified" }
      : name === "pendingRecovery" ? { state: "limited", reason: { code: "liveOnly" }, evidence: "e1Policy" }
      : { state: "unavailable", reason: { code: name === "sessionEnvironment" || name === "serviceManagement" ? "localOnly" : "deferred" }, evidence: "e1Policy" },
  ])) as Record<ServerCapability, ServerCapabilityStatus>
  return { serverId: profile.id, generation, features }
}
