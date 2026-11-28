/** CodeNomad UI/server wire contract. Increment for breaking changes consumed by the UI. */
export const CODENOMAD_API_CONTRACT = 1

/** Implemented CodeNomad route families; runtime availability still follows each route. */
export const CODENOMAD_CAPABILITIES = ["workspaces", "workspace-files", "workspace-git", "events"] as const

export interface ServerContractMeta {
  /** Public UUID persisted in this server's config. */
  serverId: string
  apiContract: number
  capabilities: string[]
}
