/** Public extension contract, independent of CodeNomad's internal Solid modules. */
export const PANEL_EXTENSION_API_VERSION = 4
export const PANEL_EXTENSION_LIMITS = { archiveBytes: 2 * 1024 * 1024, htmlBytes: 2 * 1024 * 1024, installed: 32, storageBytes: 16 * 1024 * 1024,
  preferencesBytes: 4096 } as const

/**
 * API 4's finite permission set: `session.context` plus a non-empty subset of
 * these, each one capability with fixed methods (dev-docs/PANEL_EXTENSIONS.md#api-4).
 * `session.images.prompts` requires `session.images.read`; `bundles.manage` requires `bundles.read`.
 */
export const PANEL_EXTENSION_API4_PERMISSIONS = ["session.images.read", "session.images.prompts", "composer.prefill", "images.conversation",
  "opencode.designAgent", "panel.preferences", "bundles.read", "bundles.manage"] as const
export type PanelExtensionApi4Permission = typeof PANEL_EXTENSION_API4_PERMISSIONS[number]

export type PanelExtensionManifest = {
  id: string
  name: string
  version: string
  author: string
  license: string
  repository: string
} & ({ apiVersion: 1; permissions: ["session.context"] } | { apiVersion: 2; permissions: ["session.context", "session.assets.read"] }
  | { apiVersion: 3; permissions: ["session.context", "repository.workItems.read"] }
  | { apiVersion: 4; permissions: Array<"session.context" | PanelExtensionApi4Permission> })

export type PanelExtensionPermission = "session.assets.read" | "repository.workItems.read" | PanelExtensionApi4Permission

export interface PanelExtensionSummary {
  manifest: PanelExtensionManifest
  digest: string
  enabled: boolean
}

export interface PanelExtensionContext {
  apiVersion: 1 | 2 | 3 | 4
  sessionId: string | null
  locale: string
  appearance: "light" | "dark"
  /** Resolved host appearance tokens, supplied to API 2 and later panels. */
  colors?: Record<"background" | "surface" | "text" | "muted" | "border" | "focus", string>
}

/** API 4 `images.status()`, read at the displayed conversation's Location (else the instance's current one). */
export interface PanelImagesStatus {
  generation: "available" | "disabled" | "unsupported"
  imageModels: boolean
  designAgent: "present" | "absent" | "user"
  contentVersion: number | null
  /** Whether the conversation's effective chat model takes image input; `null` without a conversation or when unknown. */
  chatModelSeesImages: boolean | null
}

/** API 4 `conversation.status()`; every field but `lookup` and `displayedIsImages` is `null` unless found. */
export interface PanelConversationStatus {
  lookup: "found" | "absent" | "unknown"
  /** The read-back images of the found conversation when its whole gallery fits one page, else `null` (more than one page, or unreadable). */
  imageCount: number | null
  /** The found conversation's last update, in ms. */
  lastUsed: number | null
  displayedIsImages: boolean
  /** A read-only check of `.codenomad/design/` in the Location's exclude file: `missing` until `open`/`startNew` appends it. */
  gitExclusion: "excluded" | "missing" | "not-repository" | "unavailable" | null
}

export type PanelPrefillStatus = "added" | "busy" | "no-session" | "too-long" | "invalid"
export type PanelPreferencesSetStatus = "saved" | "too-large" | "invalid" | "unavailable"

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
