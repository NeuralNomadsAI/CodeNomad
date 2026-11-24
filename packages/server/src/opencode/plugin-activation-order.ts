/**
 * OpenCode's applied plugin order (`config/plugin/source.ts`, `plugin/supervisor.ts`): builtin, SDK and directory
 * plugins are defined first, then every document's entries apply in document order. An add whose target matches an
 * ID defined earlier selects it (as do `*`, `prefix.*` and `opencode.*`); any other add loads a package, so a bare ID
 * with no earlier definition is a package spec. A remove disables only plugins defined before it.
 */
export interface AppliedEntry {
  document: number
  entryIndex: number
  remove: boolean
  target: string
  /** The verified ID this add defines: the runtime reports it for this source, or a verified descriptor. */
  pluginId?: string
}

export interface AppliedSequence {
  entries: AppliedEntry[]
  /** Verified IDs defined before every document: builtin, SDK and directory plugins, verified descriptors. */
  startIds: ReadonlySet<string>
}

export function matchesSelector(selector: string, pluginId: string): boolean {
  return selector === "*" || (selector.endsWith(".*") ? pluginId.startsWith(selector.slice(0, -1)) : selector === pluginId)
}

const definedAtStart = (sequence: AppliedSequence, id: string) => sequence.startIds.has(id) || id.startsWith("opencode.")

/** Whether a verified definition of `id` precedes position (`document`, `entryIndex`), ignoring `exclude`. */
export function definedBefore(sequence: AppliedSequence, id: string, document: number, entryIndex: number, exclude?: AppliedEntry): boolean {
  return definedAtStart(sequence, id) || sequence.entries.some(entry => entry !== exclude && !entry.remove && entry.pluginId === id
    && (entry.document < document || (entry.document === document && entry.entryIndex < entryIndex)))
}

/**
 * Whether `id` is enabled after the documents up to `through` (inclusive). Without a verified definition in that
 * prefix the ID is assumed defined first, so every rule that could apply to it does.
 */
export function enabledThrough(sequence: AppliedSequence, id: string, through: number): boolean {
  const prefix = sequence.entries.filter(entry => entry.document <= through)
  let defined = definedAtStart(sequence, id) || !prefix.some(entry => !entry.remove && entry.pluginId === id)
  let enabled = defined
  for (const entry of prefix) {
    if (entry.remove) { if (defined && matchesSelector(entry.target, id)) enabled = false }
    else if (entry.pluginId === id) defined = enabled = true
    else if (defined && (matchesSelector(entry.target, id))) enabled = true
  }
  return enabled
}
