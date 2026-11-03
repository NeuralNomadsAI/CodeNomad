import type { PluginConfiguredSource, PluginControlScope } from "../../../server/src/api-types"
import type { IntegrationView } from "../../../server/src/integration-types"

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
