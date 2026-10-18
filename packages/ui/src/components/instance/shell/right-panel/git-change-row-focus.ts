// Keyboard focus for Changes rows, which a bounded window may unmount. A row
// holds a focus pin while focus is inside it (see `createGitChangeWindows`).

/**
 * Releases the row's focus pin once focus has really left it: not while it
 * moves between the row's own controls, not on a window switch (focus returns
 * there), and not when the row unmounts (`keepFocusAfterRowRemoval` owns that).
 */
export function releaseWhenFocusLeaves(row: HTMLElement, release: () => void) {
  queueMicrotask(() => {
    if (row.isConnected && !row.contains(document.activeElement) && document.hasFocus()) release()
  })
}

/**
 * Call while a row unmounts (staged/unstaged into the other section, removed or
 * changed by a refresh). If it held focus, focus moves to its replacement with
 * the same item, else to what now sits in its place (the next row or the
 * section's Show more), the previous row or the section header; never `<body>`.
 */
export function keepFocusAfterRowRemoval(row: HTMLElement, release: () => void) {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || !row.contains(active)) return
  const control = Array.from(row.querySelectorAll("button")).indexOf(active as HTMLButtonElement)
  const id = row.dataset.gitItemId
  const list = row.parentElement, next = row.nextElementSibling, previous = row.previousElementSibling
  const header = row.closest(".git-change-section")?.querySelector<HTMLElement>(".git-change-section-header")
  queueMicrotask(() => {
    const current = document.activeElement
    if (row.isConnected || (current && current !== document.body)) return
    const replacement = Array.from(list?.children ?? []).find((element): element is HTMLElement =>
      element instanceof HTMLElement && element.isConnected && element.dataset.gitItemId === id)
    if (replacement) {
      const buttons = replacement.querySelectorAll<HTMLButtonElement>("button")
      ;(buttons[control] ?? buttons[0])?.focus()
      return
    }
    release()
    const neighbour = [next, previous].find(element => element?.isConnected)
    const target = neighbour?.querySelector<HTMLElement>("button:enabled") ?? (header?.isConnected ? header : null)
    target?.focus()
  })
}
