type RawPluginEntry = string | [string, Record<string, unknown>]

function normalizePluginSpecifier(plugin: string): string {
  return plugin.startsWith("file://") ? plugin.slice("file://".length) : plugin
}

export function extractConfiguredPlugins(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const plugins: string[] = []
  for (const entry of value as RawPluginEntry[]) {
    if (typeof entry === "string") {
      plugins.push(normalizePluginSpecifier(entry))
      continue
    }
    if (Array.isArray(entry) && typeof entry[0] === "string") {
      plugins.push(normalizePluginSpecifier(entry[0]))
    }
  }
  return plugins
}
