import type { PluginControlsSnapshot } from "../../api-types"
import type { IntegrationCatalog, IntegrationCatalogEntry } from "./contract"

/** A conforming catalog entry for `id` (the fake integration's names), `native` unless told otherwise. */
export function catalogEntry(id: string, overrides: Partial<IntegrationCatalogEntry> = {}): IntegrationCatalogEntry {
  const family = overrides.family ?? "native"
  return {
    id,
    package: `@neuralnomads/opencode-${id}`,
    range: "^0.1",
    displayName: `OpenCode for ${id}`,
    family,
    plugin: `neuralnomads.${id}`,
    rpc: `neuralnomads.${id}`,
    summary: { en: `Use ${id} from OpenCode.` },
    app: { name: id },
    ...(family === "native" ? { host: { protocol: 1, range: "^0.1.0" } } : {}),
    docs: `https://github.com/NeuralNomadsAI/opencode-integrations/tree/main/integrations/${id}`,
    status: "preview",
    ...overrides,
  }
}

export function catalogOf(...integrations: IntegrationCatalogEntry[]): IntegrationCatalog {
  return { schemaVersion: 1, integrations }
}

/** A plugin-controls snapshot of one Location with only the given inventory. */
export function pluginSnapshot(parts: Partial<Pick<PluginControlsSnapshot, "runtime" | "controls">> & {
  sources?: PluginControlsSnapshot["configured"]["sources"]
  rules?: PluginControlsSnapshot["configured"]["rules"]
} = {}): PluginControlsSnapshot {
  return {
    location: { directory: "/work" },
    runtime: parts.runtime ?? [],
    configured: { rules: parts.rules ?? [], sources: parts.sources ?? [] },
    controls: parts.controls ?? [],
    targets: [{ scope: "global", path: "/config/opencode.jsonc", exists: true }, { scope: "project", path: "/work/.opencode/opencode.jsonc", exists: true }],
  }
}
