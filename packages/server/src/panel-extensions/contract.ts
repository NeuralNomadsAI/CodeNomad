/** Public extension contract, independent of CodeNomad's internal Solid modules. */
export const PANEL_EXTENSION_API_VERSION = 1
export const PANEL_EXTENSION_LIMITS = { archiveBytes: 2 * 1024 * 1024, htmlBytes: 2 * 1024 * 1024, installed: 32, storageBytes: 16 * 1024 * 1024 } as const

export interface PanelExtensionManifest {
  id: string
  name: string
  version: string
  apiVersion: 1
  author: string
  license: string
  repository: string
  permissions: ["session.context"]
}

export interface PanelExtensionSummary {
  manifest: PanelExtensionManifest
  digest: string
  global: boolean
  project: boolean
  enabled: boolean
}

export interface PanelExtensionContext {
  apiVersion: 1
  sessionId: string | null
  locale: string
  appearance: "light" | "dark"
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
