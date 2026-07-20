import type { RightPanelModule, RightPanelSectionModule, RightPanelTabModule } from "./registry"

export type RightPanelPluginCleanup = () => void

export interface RightPanelPluginContext {
  instanceId: string
}

export interface RightPanelPluginLifecycle {
  onLoad?: (context: RightPanelPluginContext) => void | RightPanelPluginCleanup
  onUnload?: (context: RightPanelPluginContext) => void
}

export interface RightPanelPluginManifest {
  id: string
  tabs?: readonly RightPanelTabModule[]
  statusSections?: readonly RightPanelSectionModule[]
  lifecycle?: RightPanelPluginLifecycle
}

export interface RightPanelPluginLoadError {
  pluginId: string
  phase: "load" | "unload"
  error: unknown
}

export interface LoadedRightPanelPlugins {
  modules: RightPanelModule[]
  errors: RightPanelPluginLoadError[]
  unload: () => RightPanelPluginLoadError[]
}

export function loadRightPanelPluginManifests(
  manifests: readonly RightPanelPluginManifest[],
  context: RightPanelPluginContext,
): LoadedRightPanelPlugins {
  const modules: RightPanelModule[] = []
  const cleanupStack: { manifest: RightPanelPluginManifest; cleanup?: RightPanelPluginCleanup }[] = []
  const errors: RightPanelPluginLoadError[] = []
  const seen = new Set<string>()

  for (const manifest of manifests) {
    if (!manifest.id || seen.has(manifest.id)) {
      errors.push({ pluginId: manifest.id || "<missing>", phase: "load", error: new Error("Duplicate or missing right panel plugin id") })
      continue
    }
    seen.add(manifest.id)

    try {
      const cleanup = manifest.lifecycle?.onLoad?.(context)
      modules.push({ id: manifest.id, tabs: manifest.tabs, statusSections: manifest.statusSections })
      cleanupStack.push({ manifest, cleanup: typeof cleanup === "function" ? cleanup : undefined })
    } catch (error) {
      errors.push({ pluginId: manifest.id, phase: "load", error })
    }
  }

  return {
    modules,
    errors,
    unload: () => {
      const unloadErrors: RightPanelPluginLoadError[] = []
      for (const { manifest, cleanup } of cleanupStack.slice().reverse()) {
        try {
          cleanup?.()
          manifest.lifecycle?.onUnload?.(context)
        } catch (error) {
          unloadErrors.push({ pluginId: manifest.id, phase: "unload", error })
        }
      }
      return unloadErrors
    },
  }
}
