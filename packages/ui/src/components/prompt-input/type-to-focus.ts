const INTERACTIVE_SELECTOR =
  'button, a[href], summary, [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], [tabindex]:not([tabindex="-1"])'

const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"])

function claimsKeys(element: Element): boolean {
  return EDITABLE_TAGS.has(element.tagName)
    || Boolean((element as HTMLElement).isContentEditable)
    || Boolean(element.closest(INTERACTIVE_SELECTOR))
}

/**
 * Whether a keystroke made outside the composer should move focus into it, so
 * the character lands in the draft. Fields and controls keep their keys. The
 * conversation stream is focusable only for keyboard reading (it takes focus
 * after a send): its reading keys (arrows, paging, Space) keep scrolling it,
 * while printable characters resume typing without a click.
 */
export function shouldTypeIntoComposer(event: KeyboardEvent, focused: Element | null, conversation: Element | null): boolean {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return false
  if (event.ctrlKey || event.metaKey || event.altKey) return false
  if (event.key.length !== 1 || event.key === " ") return false
  const target = typeof (event.target as Element | null)?.closest === "function" ? event.target as Element : null
  return ![focused, target].some(element => element && element !== conversation && claimsKeys(element))
}
