/** Return a prefix within the UTF-16 limit, keeping surrogate pairs intact. */
export function truncateMissionText(value: string, limit: number): string {
  const end = Math.min(value.length, limit)
  const last = value.charCodeAt(end - 1)
  return value.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end)
}

/** Display a stored label without changing the bytes used to match its receipt. */
export function displayMissionText(value: string): string {
  return value.replace(/[\ud800-\udfff]/gu, "")
}
