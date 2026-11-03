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
  const correlated = (item: { scope: string; entryIndex: number }, list: readonly { scope: PluginControlScope; entryIndex: number }[]) =>
    list.some(association => association.scope === item.scope && association.entryIndex === item.entryIndex)
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

/**
 * The integration a Plugins row belongs to: the one integration whose `configuredSources` claim one of the row's
 * sources. Two claimants, or an ambiguous one, attribute the row to none.
 */
export function integrationForSources<T extends Pick<IntegrationView, "configuredSources" | "ambiguous">>(
  entries: readonly T[], sources: readonly Pick<PluginConfiguredSource & { scope: PluginControlScope }, "scope" | "entryIndex">[],
): T | undefined {
  const matches = entries.filter(entry => entry.configuredSources.some(association =>
    sources.some(source => source.scope === association.scope && source.entryIndex === association.entryIndex)))
  return matches.length === 1 && !matches[0]!.ambiguous ? matches[0] : undefined
}
