// Frozen, verbatim functions from message-block.tsx at
// 6f6edbbcb91227fdd1d5863f6c21fad2691de679 (only imports/exports added).
// Kept here so comparisons also run in shallow CI checkouts. Not shipped.
import type { SessionSearchMatch } from "../../../src/lib/session-search"

function removeSearchMarks(root: HTMLElement) {
  const marks = Array.from(root.querySelectorAll("mark.session-search-match"))
  for (const mark of marks) {
    const parent = mark.parentNode
    if (!parent) continue
    parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark)
    parent.normalize()
  }
}

function getPartIdForSearchContainer(container: HTMLElement): string | undefined {
  const target = container.closest<HTMLElement>("[data-part-id]") ?? container
  const id = target.dataset.partId
  return id && id.length > 0 ? id : undefined
}

function applySearchMarks(root: HTMLElement, query: string, activeMatch?: SessionSearchMatch | null, scrollActive = false) {
  removeSearchMarks(root)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return

  const containers = Array.from(root.querySelectorAll<HTMLElement>(".message-text, .tool-call, .message-reasoning-text"))
  let occurrenceInActivePart = 0
  let activeMark: HTMLElement | null = null

  for (const container of containers) {
    const containerPartId = getPartIdForSearchContainer(container)
    const canContainActiveMatch = Boolean(activeMatch) && (!activeMatch?.partId || activeMatch.partId === containerPartId)
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement
        if (!parent) return NodeFilter.FILTER_REJECT
        if (parent.closest("button, input, textarea, select, mark.session-search-match")) return NodeFilter.FILTER_REJECT
        if (!node.nodeValue || !node.nodeValue.toLocaleLowerCase().includes(normalizedQuery)) return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_ACCEPT
      },
    })

    const textNodes: Text[] = []
    while (walker.nextNode()) {
      textNodes.push(walker.currentNode as Text)
    }

    for (const textNode of textNodes) {
      const original = textNode.nodeValue ?? ""
      const lower = original.toLocaleLowerCase()
      const fragment = document.createDocumentFragment()
      let cursor = 0
      while (cursor < original.length) {
        const index = lower.indexOf(normalizedQuery, cursor)
        if (index === -1) break
        if (index > cursor) {
          fragment.appendChild(document.createTextNode(original.slice(cursor, index)))
        }
        const mark = document.createElement("mark")
        const isActive = Boolean(canContainActiveMatch && activeMatch && occurrenceInActivePart === activeMatch.occurrence)
        mark.className = isActive ? "session-search-match session-search-match-active" : "session-search-match"
        mark.textContent = original.slice(index, index + normalizedQuery.length)
        fragment.appendChild(mark)
        if (canContainActiveMatch) {
          if (isActive) activeMark = mark
          occurrenceInActivePart += 1
        }
        cursor = index + normalizedQuery.length
      }
      if (cursor < original.length) {
        fragment.appendChild(document.createTextNode(original.slice(cursor)))
      }
      textNode.parentNode?.replaceChild(fragment, textNode)
    }
  }

  if (activeMark && scrollActive) {
    requestAnimationFrame(() => activeMark?.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" }))
  }
}

export { applySearchMarks, removeSearchMarks }
