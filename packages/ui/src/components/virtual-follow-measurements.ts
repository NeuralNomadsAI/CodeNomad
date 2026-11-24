import type { VirtualizerHandle } from "virtua/solid"

// virtua caches by index, while transcript identity survives an optimistic
// reorder. Preserve retained measurements by key rather than throwing away
// the entire scroll extent when those indices change.
export function remapVirtualMeasurements(
  previousKeys: readonly string[],
  nextKeys: readonly string[],
  cache: VirtualizerHandle["cache"] | undefined,
  measureTail = false,
  pendingProbeKeys: readonly string[] = [],
): { cache: VirtualizerHandle["cache"]; probes: number[] } | undefined {
  if (!cache) return undefined
  const sizes = new Map(previousKeys.map((key, index) => [key, cache[0][index] ?? -1]))
  if (!nextKeys.some(key => sizes.has(key))) return undefined
  // A zero-seeded insertion is not an authoritative zero until measured. If
  // another reset happens first, either probe it again or restore estimation.
  // Positive measurements have already settled and need no special treatment.
  const pending = new Set(pendingProbeKeys.filter(key => sizes.has(key) && sizes.get(key)! <= 0))
  pending.forEach(key => sizes.set(key, -1))
  const inserted = nextKeys.flatMap((key, index) => sizes.has(key) ? [] : [index])
  const unmeasuredTail = measureTail ? new Set(previousKeys.slice(-8).filter(key => (sizes.get(key) ?? -1) < 0)) : new Set<string>()
  const candidates = [...inserted, ...nextKeys.flatMap((key, index) => pending.has(key) || unmeasuredTail.has(key) ? [index] : [])]
  // A handful of inserted rows are mounted immediately for measurement. Start
  // them at zero rather than estimating hidden metadata at the average height
  // of a long reply, which would overshoot bottom then jump back down.
  const probes = candidates.length <= 8 ? candidates : []
  const measuredNextFrame = new Set(probes)
  const retained = nextKeys.flatMap(key => sizes.has(key) ? [sizes.get(key)!] : [])
  // The remount keeps the default as Virtua's `itemSize`, which never re-estimates.
  // When every retained row is measured, refreshing it resizes no retained row and
  // only sizes rows this remount inserts. It replaces Virtua's 40px fallback or an
  // early guess carried by an instance that remounted before estimating.
  const defaultSize = retained.every(size => size >= 0) ? medianSize(retained) ?? cache[1] : cache[1]
  return { cache: [nextKeys.map((key, index) => measuredNextFrame.has(index) ? 0 : sizes.get(key) ?? -1), defaultSize], probes }
}

/** Virtua's own estimate: the median of non-zero measured sizes. */
function medianSize(sizes: number[]) {
  const sorted = sizes.filter(size => size > 0).sort((a, b) => a - b)
  if (sorted.length === 0) return undefined
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
