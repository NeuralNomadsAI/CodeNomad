const rowMain = (element: Element | null) =>
  element?.matches("[data-git-item-id]") ? element.querySelector<HTMLButtonElement>(".git-panel-file-main") : null
const hiddenRowsButton = (element: Element) =>
  element.matches(".git-change-hidden-rows") ? element.querySelector<HTMLButtonElement>("button") : null

const siblings = (row: Element, direction: "nextElementSibling" | "previousElementSibling") => {
  const elements: Element[] = []
  for (let element = row[direction]; element; element = element[direction]) elements.push(element)
  return elements
}

/**
 * Call while a Changes row unmounts (staged/unstaged into the other section, or
 * changed or removed by a refresh). If it held focus, focus moves to the same
 * control of its replacement for the same item, else to the nearest following
 * row or "not shown" control that survived (a bulk move removes neighbours in
 * the same update), the nearest preceding row, or the section header without
 * scrolling. Only rows and the section's own controls qualify, never the commit
 * box or an action on another file, so the next Enter cannot act on something else.
 */
export function keepFocusAfterRowRemoval(row: HTMLElement) {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || !row.contains(active)) return
  const control = Array.from(row.querySelectorAll("button")).indexOf(active as HTMLButtonElement)
  const list = row.parentElement, following = siblings(row, "nextElementSibling"), preceding = siblings(row, "previousElementSibling")
  const header = row.closest(".git-change-section")?.querySelector<HTMLButtonElement>(".git-change-section-header")
  queueMicrotask(() => {
    const current = document.activeElement
    if (row.isConnected || (current && current !== document.body)) return
    const replacement = Array.from(list?.children ?? []).find(element => element !== row && rowMain(element)
      && (element as HTMLElement).dataset.gitItemId === row.dataset.gitItemId)
    const candidates = [
      replacement?.querySelectorAll("button")[control], rowMain(replacement ?? null),
      ...following.map(element => rowMain(element) ?? hiddenRowsButton(element)), ...preceding.map(rowMain),
    ]
    for (const candidate of candidates) {
      if (!candidate?.isConnected || candidate.disabled) continue
      candidate.focus()
      if (document.activeElement === candidate) return
    }
    if (header?.isConnected) header.focus({ preventScroll: true })
  })
}
