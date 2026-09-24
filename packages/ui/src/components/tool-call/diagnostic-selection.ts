export function selectSeverityBounded<T>(values: readonly T[], rank: (value: T) => number | undefined, limit: number): T[] {
  const buckets: T[][] = [[], [], []]
  const scanLimit = Math.max(limit, limit * 100)
  for (let index = 0; index < values.length && index < scanLimit; index += 1) {
    const value = values[index]
    const valueRank = rank(value)
    if (valueRank === undefined) continue
    const bucket = buckets[Math.max(0, Math.min(2, valueRank))]!
    if (bucket.length < limit) bucket.push(value)
  }
  return buckets.flat().slice(0, limit)
}
