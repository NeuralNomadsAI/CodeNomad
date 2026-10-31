// Customizable selects expose their list as :open; system lists consume Escape themselves.
// Popups stop Escape only while that list is open, so the first Escape closes the list.
export function nativeSelectListOpen(select: HTMLSelectElement): boolean {
  try { return select.matches(":open") } catch { return false }
}
