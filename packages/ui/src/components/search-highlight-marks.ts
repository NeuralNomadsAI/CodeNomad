import type { SearchRange } from "./search-highlight-ranges"

/** Partition original text once: expanded case folds can map disjoint hits to overlapping characters. */
export function paintSearchMarks(ranges: SearchRange[]): { marks: HTMLElement[]; activeRange?: Range } {
  const nodes = new Map<Text, Map<number, { matches: number; active: number }>>()
  for (const { range, active } of ranges) {
    const node = range.startContainer as Text
    let boundaries = nodes.get(node)
    if (!boundaries) { boundaries = new Map(); nodes.set(node, boundaries) }
    for (const [offset, delta] of [[range.startOffset, 1], [range.endOffset, -1]]) {
      const value = boundaries.get(offset) ?? { matches: 0, active: 0 }
      value.matches += delta
      if (active) value.active += delta
      boundaries.set(offset, value)
    }
  }
  const marks: HTMLElement[] = []
  let activeMark: HTMLElement | undefined
  for (const [node, boundaries] of nodes) {
    const document = node.ownerDocument
    const fragment = document.createDocumentFragment()
    const text = node.data
    const offsets = [...new Set([0, text.length, ...boundaries.keys()])].sort((a, b) => a - b)
    let matches = 0, active = 0
    let previousActive: HTMLElement | undefined
    for (let index = 0; index < offsets.length - 1; index++) {
      const start = offsets[index], end = offsets[index + 1]
      const change = boundaries.get(start)
      matches += change?.matches ?? 0
      active += change?.active ?? 0
      const content = document.createTextNode(text.slice(start, end))
      if (matches === 0) {
        fragment.appendChild(content)
        previousActive = undefined
      } else if (active && previousActive) {
        previousActive.appendChild(content)
      } else {
        const mark = document.createElement("mark")
        mark.className = active ? "session-search-match session-search-match-active" : "session-search-match"
        mark.appendChild(content)
        fragment.appendChild(mark)
        marks.push(mark)
        previousActive = active ? mark : undefined
        if (active) activeMark = mark
      }
    }
    node.replaceWith(fragment)
  }
  const activeRange = activeMark?.ownerDocument.createRange()
  if (activeRange && activeMark) activeRange.selectNodeContents(activeMark)
  return { marks, activeRange }
}
