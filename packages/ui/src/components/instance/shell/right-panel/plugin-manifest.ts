import type { Accessor } from "solid-js"
import type { RightPanelModule } from "./registry"

export interface RightPanelHostContext {
  instanceId: string
  t: (key: string, vars?: Record<string, any>) => string
  activeSessionId: Accessor<string | null>
  isTabActive: (tabId: string) => boolean
  openTab: (tabId: string) => void
  reportAttention?: (attention: RightPanelAttention) => void
}

export interface RightPanelAttention {
  moduleId: string
  tabId?: string
  messageKey: string
  severity: "info" | "warning" | "critical"
}

export interface RightPanelManifest {
  id: string
  displayNameKey: string
  descriptionKey?: string
  origin: "first-party"
  create: (host: RightPanelHostContext) => RightPanelModule
}

export interface RightPanelPluginLoadError {
  pluginId: string
  displayNameKey?: string
  phase: "create"
  error: unknown
}

export interface LoadedRightPanelPlugins {
  modules: RightPanelModule[]
  errors: RightPanelPluginLoadError[]
}

export function loadRightPanelPluginManifests(
  manifests: readonly RightPanelManifest[],
  context: RightPanelHostContext,
): LoadedRightPanelPlugins {
  const modules: RightPanelModule[] = []
  const errors: RightPanelPluginLoadError[] = []
  const seen = new Set<string>()

  for (const manifest of manifests) {
    if (!manifest.id || seen.has(manifest.id)) {
      errors.push({
        pluginId: manifest.id || "<missing>",
        displayNameKey: manifest.displayNameKey,
        phase: "create",
        error: new Error("Duplicate or missing right panel plugin id"),
      })
      continue
    }
    seen.add(manifest.id)

    try {
      const module = manifest.create(context)
      modules.push({
        ...module,
        id: manifest.id,
        displayNameKey: manifest.displayNameKey,
        descriptionKey: manifest.descriptionKey ?? module.descriptionKey,
        origin: manifest.origin,
      })
    } catch (error) {
      errors.push({ pluginId: manifest.id, displayNameKey: manifest.displayNameKey, phase: "create", error })
    }
  }

  return { modules, errors }
}
