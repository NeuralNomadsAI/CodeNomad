import type { z } from "zod"
import { bundlesStateResultSchema, type bundlesStateHostResultSchema } from "../../../../server/src/panel-extensions/bundles-contract"
import { pluginSourcesStore, type PluginSourcesStore } from "../../stores/plugin-sources"

/** Strip private HTTP correlation before public validation and MessagePort delivery. */
export function projectBundlesInstallationState(instance: string, response: z.infer<typeof bundlesStateHostResultSchema>,
  store: PluginSourcesStore = pluginSourcesStore) {
  const { tracking, ...state } = response
  const location = tracking && { directory: tracking.directory }
  if (location) {
    for (const attempt of store.addedSpecs(instance, location)) {
      const token = attempt.integration ? attempt.spec : attempt.trackingTarget
      if (token && attempt.observed && tracking.declaredTargets && !tracking.declaredTargets.includes(token)) {
        store.consume(attempt); continue
      }
      const integration = attempt.integration ?? tracking.sources.find(source => source.target === token)?.integration
      const item = state.integrations.find(item => item.id === integration)
      if (!item?.plugin) continue
      const declared = tracking.sources.some(source => source.integration === integration
        && source.scope === attempt.scope && source.target === token)
      // Catalogue absence/ambiguity is not declaration-removal evidence.
      if (declared || item.plugin.runtime === "active" || item.plugin.runtime === "failed") {
        store.observe(attempt, declared, item.plugin.runtime === "active" || item.plugin.runtime === "failed")
      }
    }
  }
  return bundlesStateResultSchema.parse({ ...state, integrations: state.integrations.map(item => {
    if (!item.plugin) return item // Older contracts retain their truthful existing projection.
    const { progress: _progress, ...plugin } = item.plugin
    if (!plugin.declared || plugin.runtime !== "unloaded" || item.activation.effective === "disabled") return { ...item, plugin }
    const sources = tracking?.sources.filter(source => source.integration === item.id) ?? []
    const source = sources.length === 1 ? sources[0] : undefined
    const progress = location && source ? store.state(instance, location, source.target, source.scope) : "unconfirmed"
    return { ...item, plugin: { ...plugin, progress } }
  }) })
}
