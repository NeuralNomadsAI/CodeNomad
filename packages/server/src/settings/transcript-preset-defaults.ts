import { isPlainObject } from "./merge-patch"

export function transcriptPresetFallbacks(preset: unknown) {
  return {
    toolGroupVisibility: preset === "everything" ? "expanded" : "collapsed",
    usageMetricsExpansion: preset === "everything" || preset === "custom" || preset === "detailed" ? "expanded" : "collapsed",
  } as const
}

export function preserveLegacyTranscriptDefaults(owner: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch) || !isPlainObject(patch.settings)) return patch
  const changes = patch.settings
  if (!isPlainObject(changes.toolCallExpansionDefaults) || changes.toolCallExpansionDefaults.preset !== "custom") return patch

  const base = isPlainObject(owner) && isPlainObject(owner.settings) ? owner.settings : {}
  const preset = isPlainObject(base.toolCallExpansionDefaults) ? base.toolCallExpansionDefaults.preset : undefined
  const inherited = transcriptPresetFallbacks(preset)
  const custom = transcriptPresetFallbacks("custom")
  const settings = { ...changes }
  for (const key of ["toolGroupVisibility", "usageMetricsExpansion"] as const) {
    if (inherited[key] === custom[key] || Object.hasOwn(changes, key)) continue
    const saved = base[key]
    if (saved === "collapsed" || saved === "expanded" || (key === "toolGroupVisibility" && saved === "hidden")) continue
    settings[key] = inherited[key]
  }
  return { ...patch, settings }
}
