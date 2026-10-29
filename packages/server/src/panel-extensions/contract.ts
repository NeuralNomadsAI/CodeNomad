/** Public extension contract, independent of CodeNomad's internal Solid modules. */
export const PANEL_EXTENSION_API_VERSION = 3
export const PANEL_EXTENSION_LIMITS = { archiveBytes: 2 * 1024 * 1024, htmlBytes: 2 * 1024 * 1024, installed: 32, storageBytes: 16 * 1024 * 1024 } as const

export type PanelExtensionManifest = {
  id: string
  name: string
  version: string
  author: string
  license: string
  repository: string
} & ({ apiVersion: 1; permissions: ["session.context"] } | { apiVersion: 2; permissions: ["session.context", "session.assets.read"] }
  | { apiVersion: 3; permissions: ["session.context", "repository.workItems.read"] })

export type PanelExtensionPermission = "session.assets.read" | "repository.workItems.read"

export interface PanelExtensionSummary {
  manifest: PanelExtensionManifest
  digest: string
  enabled: boolean
}

export interface PanelExtensionContext {
  apiVersion: 1 | 2 | 3
  sessionId: string | null
  locale: string
  appearance: "light" | "dark"
  /** Resolved host appearance tokens, supplied to API 2 and later panels. */
  colors?: Record<"background" | "surface" | "text" | "muted" | "border" | "focus", string>
}

export type ForgeProvider = "github" | "gitlab" | "gitea"
export type ForgeWorkItemKind = "issue" | "pullRequest"

/** The repository a project contributes to, as API 3 panels see it: never its directory, remote URL or credentials. */
export interface ForgeRepository {
  provider: ForgeProvider
  host: string
  /** `owner/repo`, or `group/subgroup/project` on GitLab. */
  path: string
  webUrl: string
  /** Read through the user's signed-in CLI, or anonymously (public repositories only). */
  access: "cli" | "anonymous"
}

export interface ForgeWorkItem {
  kind: ForgeWorkItemKind
  number: number
  title: string
  state: "open" | "closed" | "merged"
  draft: boolean
  author?: string
  labels: string[]
  updatedAt: string
  url: string
}

export type ForgeUnavailableReason = "no_remote" | "unsupported_host" | "sign_in" | "rate_limited"

export type ForgeWorkItemsResult =
  | { status: "ok"; repository: ForgeRepository; items: ForgeWorkItem[]; page: number; hasMore: boolean; total?: number }
  | { status: "unavailable"; reason: ForgeUnavailableReason }

export interface PanelExtensionCatalogEntry {
  manifest: Omit<PanelExtensionManifest, "apiVersion" | "permissions"> & { apiVersion: number; permissions: string[] }
  description: string
  digest: string
  release: { tag: string; asset: string }
  compatible: boolean
}

export interface PanelExtensionCatalog {
  source: string
  entries: PanelExtensionCatalogEntry[]
}
