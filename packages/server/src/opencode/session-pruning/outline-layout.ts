import { MESSAGE_DISPLAY_HEAD, MESSAGE_DISPLAY_LIMIT, MESSAGE_DISPLAY_TAIL, type OutlineEntry } from "./navigation-contract"

/**
 * The markers of the parts a step's transcript displays (`MESSAGE_DISPLAY_*`):
 * one per native text or thinking run and per tool, a run being split only by
 * the omitted parts. `kinds` are `index || kind` pairs (`R`, `T` or `X`) whose
 * order is unspecified, so the part index orders them; `parts` counts the
 * displayed message's parts, including the blank error row the transcript adds.
 */
export function displayLayout(kinds: unknown, parts: number): Pick<OutlineEntry, "layout" | "omitted"> {
  const omitting = parts > MESSAGE_DISPLAY_LIMIT, tailStart = parts - MESSAGE_DISPLAY_TAIL
  const omitted = { reasoning: 0, text: 0, continues: false }
  let head = "", tail = "", previous = ""
  for (const [index, kind] of typeof kinds === "string" && kinds
    ? kinds.split(",").map(item => [Number.parseInt(item, 10), item.slice(-1)] as const).sort((a, b) => a[0] - b[0]) : []) {
    // Blank parts have no kind, so a run continues across them.
    const starts = kind === "X" || kind !== previous
    previous = kind
    if (!omitting || index < MESSAGE_DISPLAY_HEAD) head += starts ? kind : ""
    else if (index < tailStart) { if (starts && kind !== "X") omitted[kind === "R" ? "reasoning" : "text"]++ }
    else {
      if (!tail && !starts) omitted.continues = true
      tail += starts || !tail ? kind : ""
    }
  }
  return omitting ? { layout: `${head}-${tail}`, omitted } : { layout: head }
}
