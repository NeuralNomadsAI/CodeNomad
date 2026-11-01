import npa from "npm-package-arg"
import type {
  PluginActivationControl,
  PluginConfigScope,
  PluginConfiguredSource,
  PluginControlsSnapshot,
  PluginRuntimeInventoryEntry,
} from "../../api-types"
import type { IntegrationCatalog, IntegrationCatalogEntry } from "./contract"

export type IntegrationRecognitionWay = "package" | "plugin" | "git"

/** A catalog integration as the configuration and the runtime inventory show it, before any RPC. */
export interface IntegrationRecognition {
  entry: IntegrationCatalogEntry
  /** Configured: at least one way recognised it. */
  ways: IntegrationRecognitionWay[]
  sources: PluginConfiguredSource[]
  /** Scopes that declare one of its sources or an activation rule for its plugin ID. */
  scopes: PluginConfigScope[]
  control?: PluginActivationControl
  runtime?: PluginRuntimeInventoryEntry
  /** A source that also designates another integration, or loaded under another plugin ID. */
  ambiguous: boolean
}

/**
 * Package name of a registry spec, the alias target for `npm:` aliases; none for Git, local and other specs, whose
 * name `npm-package-arg` cannot know without installing them.
 */
export function registryPackageName(spec: string): string | undefined {
  let parsed: npa.Result
  try {
    parsed = npa(spec)
  } catch {
    return undefined
  }
  if (parsed.type === "alias") return (parsed as npa.AliasResult).subSpec?.name?.toLowerCase() ?? undefined
  return parsed.registry && parsed.name ? parsed.name.toLowerCase() : undefined
}

/** Catalog integrations a source spec designates by package name (way 1) or Git prefix (way 3). */
export function integrationsForSpec(catalog: IntegrationCatalog, spec: string): IntegrationCatalogEntry[] {
  const name = registryPackageName(spec)
  return catalog.integrations.filter(entry => (name !== undefined && name === entry.package)
    || (entry.sources?.git ?? []).some(prefix => spec.startsWith(prefix)))
}

/**
 * Three-way recognition (spec change §4.2): a configured source is the catalog integration `X` when its registry
 * package is `X.package`, when the runtime loaded it as `X.plugin` (or the effective configuration holds the exact
 * rule `-X.plugin`, since OpenCode lists no disabled plugin), or when its Git spec starts with a prefix of
 * `X.sources.git`. A source designating two integrations makes both ambiguous. Nothing reads OpenCode's cache.
 */
export function recognizeIntegrations(catalog: IntegrationCatalog, snapshot: PluginControlsSnapshot): IntegrationRecognition[] {
  const designated = new Map<PluginConfiguredSource, Set<string>>()
  const recognitions = catalog.integrations.map((entry): IntegrationRecognition => {
    const ways = new Set<IntegrationRecognitionWay>()
    const sources: PluginConfiguredSource[] = []
    let ambiguous = false
    for (const source of snapshot.configured.sources) {
      const byPackage = registryPackageName(source.target) === entry.package
      const byPlugin = source.pluginId === entry.plugin
      const byGit = (entry.sources?.git ?? []).some(prefix => source.target.startsWith(prefix))
      if (!byPackage && !byPlugin && !byGit) continue
      if (byPackage) ways.add("package")
      if (byPlugin) ways.add("plugin")
      if (byGit) ways.add("git")
      // Its package or Git source loaded under another plugin ID: the package is not this integration.
      if (source.pluginId !== undefined && source.pluginId !== entry.plugin) ambiguous = true
      sources.push(source)
      const set = designated.get(source) ?? new Set<string>()
      designated.set(source, set.add(entry.id))
    }
    const candidates = snapshot.runtime.filter(candidate => {
      const target = candidate.source.type === "package" ? candidate.source.target : undefined
      if (candidate.id === undefined && target !== undefined && sources.filter(source => source.target === target).length > 1) ambiguous = true
      return candidate.id === entry.plugin || (candidate.id === undefined && candidate.state.status === "failed"
        && target !== undefined && sources.filter(source => source.target === target).length === 1)
    })
    if (candidates.length > 1) ambiguous = true
    const runtime = candidates.length === 1 ? candidates[0] : undefined
    const rules = snapshot.configured.rules.filter(rule => rule.selector === entry.plugin)
    if (candidates.length > 0 || rules.some(rule => !rule.enabled)) ways.add("plugin")
    const control = snapshot.controls.find(candidate => candidate.id === entry.plugin)
    const scopes = [...new Set([...sources, ...(ways.has("plugin") ? rules : [])].map(item => item.scope))]
    return { entry, ways: [...ways], sources, scopes, control, runtime, ambiguous }
  })
  for (const recognition of recognitions) {
    if (recognition.sources.some(source => (designated.get(source)?.size ?? 0) > 1)) recognition.ambiguous = true
  }
  return recognitions
}
