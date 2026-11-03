/** Nested pickers and dialogs own dismissal before the floating panel beneath them. */
export function isNestedDrawerSurface(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(
    '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"], [aria-haspopup="menu"][aria-expanded="true"], [aria-haspopup="listbox"][aria-expanded="true"], [aria-haspopup="dialog"][aria-expanded="true"]',
  ))
}
