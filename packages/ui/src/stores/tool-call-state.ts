import { createSignal } from "solid-js"

const [expandedItems, setExpandedItems] = createSignal<Set<string>>(new Set())

export function isItemExpanded(itemId: string): boolean {
  return expandedItems().has(itemId)
}

export function toggleItemExpanded(itemId: string): void {
  setExpandedItems((prev) => {
    const next = new Set(prev)
    if (next.has(itemId)) {
      next.delete(itemId)
    } else {
      next.add(itemId)
    }
    return next
  })
}

export function setItemExpanded(itemId: string, expanded: boolean): void {
  setExpandedItems((prev) => {
    const next = new Set(prev)
    if (expanded) {
      next.add(itemId)
    } else {
      next.delete(itemId)
    }
    return next
  })
}

// Backward compatibility aliases
export const isToolCallExpanded = isItemExpanded
export const toggleToolCallExpanded = toggleItemExpanded
export const setToolCallExpanded = setItemExpanded
