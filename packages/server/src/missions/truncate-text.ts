/** Return a prefix within the UTF-16 limit, keeping surrogate pairs intact. */
export function truncateMissionText(value: string, limit: number): string {
  const end = Math.min(value.length, limit)
  const last = value.charCodeAt(end - 1)
  return value.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end)
}
