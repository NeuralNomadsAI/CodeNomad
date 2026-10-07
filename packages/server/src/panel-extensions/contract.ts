/** Public extension contract, independent of CodeNomad's internal Solid modules. */
export const PANEL_EXTENSION_API_VERSION = 2
export const PANEL_EXTENSION_LIMITS = { archiveBytes: 2 * 1024 * 1024, htmlBytes: 2 * 1024 * 1024, installed: 32, storageBytes: 16 * 1024 * 1024 } as const

export type PanelExtensionManifest = {
  id: string
  name: string
  version: string
  author: string
  license: string
  repository: string
} & ({ apiVersion: 1; permissions: ["session.context"] } | { apiVersion: 2; permissions: ["session.context", "session.assets.read"] })

export interface PanelExtensionSummary {
  manifest: PanelExtensionManifest
  digest: string
  enabled: boolean
}

export interface PanelExtensionContext {
  apiVersion: 1 | 2
  sessionId: string | null
  locale: string
  appearance: "light" | "dark"
  /** Resolved host appearance tokens, supplied to API 2 panels only. */
  colors?: Record<"background" | "surface" | "text" | "muted" | "border" | "focus", string>
}

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
