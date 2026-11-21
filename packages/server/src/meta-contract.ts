/** CodeNomad UI/server wire contract. Increment for breaking changes consumed by the UI. */
export const CODENOMAD_API_CONTRACT = 1

/**
 * CodeNomad route families. A server declares the families it serves; the UI hides the features of
 * undeclared families (dev-docs/architecture.md#server-metadata-contract). Runtime availability still
 * follows each route.
 */
export const CODENOMAD_CAPABILITIES = [
  "workspaces", "workspace-files", "workspace-git", "events",
  "linked-worktrees", "force-worktree-delete", "workspace-clone", "temporary-workspaces",
  "missions", "conversation-permissions", "session-goals", "history-search", "background-shells",
  "plugin-controls", "integrations", "websearch-settings", "image-settings", "provider-usage", "service-usage",
  "speech", "previews", "sidecars", "remote-control", "opencode-admin", "config-files",
] as const

export type CodeNomadCapability = typeof CODENOMAD_CAPABILITIES[number]

export interface ServerContractMeta {
  /** Public UUID persisted in this server's config. */
  serverId: string
  apiContract: number
  capabilities: string[]
}
