const rowMain = (element: Element | null) =>
  element?.matches("[data-git-item-id]") ? element.querySelector<HTMLButtonElement>(".git-panel-file-main") : null

/**
 * Call while a Changes row unmounts (staged/unstaged into the other section, or
 * changed or removed by a refresh). If it held focus, focus moves to the same
 * control of its replacement for the same item, else to the row or "not shown"
 * control now at its position, the previous row, or the section header. Only
 * rows and the section's own controls qualify, never the commit box or an action
 * on another file, so the next Enter cannot act on something else.
 */
export function keepFocusAfterRowRemoval(row: HTMLElement) {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || !row.contains(active)) return
  const control = Array.from(row.querySelectorAll("button")).indexOf(active as HTMLButtonElement)
  const list = row.parentElement, next = row.nextElementSibling, previous = row.previousElementSibling
  const header = row.closest(".git-change-section")?.querySelector<HTMLButtonElement>(".git-change-section-header")
  queueMicrotask(() => {
    const current = document.activeElement
    if (row.isConnected || (current && current !== document.body)) return
    const replacement = Array.from(list?.children ?? []).find(element => element !== row && rowMain(element)
      && (element as HTMLElement).dataset.gitItemId === row.dataset.gitItemId)
    const candidates = [
      replacement?.querySelectorAll("button")[control], rowMain(replacement ?? null),
      rowMain(next), next?.matches(".git-change-hidden-rows") ? next.querySelector("button") : null,
      rowMain(previous), header,
    ]
    for (const candidate of candidates) {
      if (!candidate?.isConnected || candidate.disabled) continue
      candidate.focus()
      if (document.activeElement === candidate) return
    }
  })
}
