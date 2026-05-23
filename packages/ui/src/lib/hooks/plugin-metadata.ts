function normalizePluginSpecifier(plugin: string): string {
  return plugin.startsWith("file://") ? plugin.slice("file://".length) : plugin
}

function isPluginTuple(entry: unknown): entry is [string, Record<string, unknown>] {
  return (
    Array.isArray(entry) &&
    entry.length === 2 &&
    typeof entry[0] === "string" &&
    typeof entry[1] === "object" &&
    entry[1] !== null &&
    !Array.isArray(entry[1])
  )
}

export function extractConfiguredPlugins(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const plugins: string[] = []
  for (const entry of value) {
    if (typeof entry === "string") {
      plugins.push(normalizePluginSpecifier(entry))
      continue
    }
    if (isPluginTuple(entry)) {
      plugins.push(normalizePluginSpecifier(entry[0]))
    }
  }
  return plugins
}
