import type {
  PluginActivationControl,
  PluginConfiguredSource,
  PluginControlScope,
  PluginControlsSnapshot,
  PluginRuntimeSource,
} from "../../../server/src/api-types"
import type { IntegrationView } from "../../../server/src/integration-types"

/** An integration's plugin as the plugin-controls snapshot shows it, found through the view's safe correlations. */
export interface IntegrationPlugin {
  /** Its declarations, in snapshot order. */
  sources: PluginConfiguredSource[]
  /** The activation control of its plugin, when a declaration loaded it or a rule names it. */
  control?: PluginActivationControl
  /** Its package as the runtime inventory reports it, for the native check/update action. */
  source?: PluginRuntimeSource
}

export function integrationPlugin(snapshot: PluginControlsSnapshot | undefined,
  entry: Pick<IntegrationView, "configuredSources" | "configuredRules">): IntegrationPlugin {
  if (!snapshot) return { sources: [] }
  // Independent reads can reuse an index for another plugin. Only the same verified writable document joins them.
  const correlated = (item: { scope: string; path?: string; entryIndex: number },
    list: readonly { scope: PluginControlScope; entryIndex: number; expectedRevision?: string }[]) =>
    list.some(association => association.scope === item.scope && association.entryIndex === item.entryIndex
      && typeof association.expectedRevision === "string" && association.expectedRevision.length > 0
      && snapshot.targets.some(target => target.scope === item.scope && target.path === item.path
        && target.expectedRevision === association.expectedRevision))
  const sources = snapshot.configured.sources.filter(source => correlated(source, entry.configuredSources))
  const ids = new Set([
    ...sources.flatMap(source => source.pluginId ? [source.pluginId] : []),
    ...snapshot.configured.rules.filter(rule => correlated(rule, entry.configuredRules ?? [])).map(rule => rule.selector),
  ])
  // Two plugin IDs cannot both be this integration's: leave the switches out rather than guess.
  const control = ids.size === 1 ? snapshot.controls.find(candidate => candidate.id === [...ids][0]) : undefined
  const targets = new Set(sources.map(source => source.target))
  const source = control?.runtime?.source
    ?? snapshot.runtime.find(item => item.source.type === "package" && targets.has(item.source.target))?.source
  return { sources, ...(control ? { control } : {}), ...(source ? { source } : {}) }
}

/** Read-only row identity for inherited, virtual or runtime-only plugins; writable correlations stay separate. */
export function integrationDisplayPlugin(snapshot: PluginControlsSnapshot | undefined,
  entry: Pick<IntegrationView, "configuredSources" | "configuredRules" | "plugin" | "ambiguous">): IntegrationPlugin {
  if (entry.ambiguous) return { sources: [] }
  const configured = integrationPlugin(snapshot, entry)
  if (configured.control || configured.sources.length || !snapshot || !entry.plugin.runtimeId) return configured
  const matches = snapshot.runtime.filter(runtime => runtime.id === entry.plugin.runtimeId)
  if (matches.length !== 1) return configured
  const runtime = matches[0]!
  const controls = snapshot.controls.filter(control => control.id === runtime.id && control.runtime?.key === runtime.key)
  return { sources: [], ...(controls.length === 1 ? { control: controls[0] } : {}), source: runtime.source }
}
