import type { VirtualizerHandle } from "virtua/solid"

// virtua caches by index, while transcript identity survives an optimistic
// reorder. Preserve retained measurements by key rather than throwing away
// the entire scroll extent when those indices change.
export function remapVirtualMeasurements(
  previousKeys: readonly string[],
  nextKeys: readonly string[],
  cache: VirtualizerHandle["cache"] | undefined,
  measureTail = false,
): { cache: VirtualizerHandle["cache"]; probes: number[] } | undefined {
  if (!cache) return undefined
  const sizes = new Map(previousKeys.map((key, index) => [key, cache[0][index] ?? -1]))
  if (!nextKeys.some(key => sizes.has(key))) return undefined
  const inserted = nextKeys.flatMap((key, index) => sizes.has(key) ? [] : [index])
  const unmeasuredTail = measureTail ? new Set(previousKeys.slice(-8).filter(key => (sizes.get(key) ?? -1) < 0)) : new Set<string>()
  const candidates = [...inserted, ...nextKeys.flatMap((key, index) => unmeasuredTail.has(key) ? [index] : [])]
  // A handful of inserted rows are mounted immediately for measurement. Start
  // them at zero rather than estimating hidden metadata at the average height
  // of a long reply, which would overshoot bottom then jump back down.
  const probes = candidates.length <= 8 ? candidates : []
  const measuredNextFrame = new Set(probes)
  return { cache: [nextKeys.map((key, index) => measuredNextFrame.has(index) ? 0 : sizes.get(key) ?? -1), cache[1]], probes }
}
