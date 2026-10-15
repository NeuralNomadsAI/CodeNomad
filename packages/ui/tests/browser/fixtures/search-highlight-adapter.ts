import { applySearchHighlights as candidateApply, clearSearchHighlights as candidateClear, type SearchRevealRequest } from "../../../src/components/search-highlights"
import type { AlignInTranscript } from "../../../src/components/search-highlight-ranges"
import { applySearchMarks, removeSearchMarks } from "./search-highlight-baseline"
import type { SessionSearchMatch } from "../../../src/lib/session-search"
export type { SearchRevealRequest }

export const mode = new URLSearchParams(location.search).get("mode") ?? "css"
export const samples: number[] = []
export let recording = false
export function record(value: boolean) { recording = value; if (value) samples.length = 0 }
function measure(work: () => void) {
  if (!recording) return work()
  const start = performance.now()
  try { work() } finally { samples.push(performance.now() - start) }
}
export function applySearchHighlights(root: HTMLElement, query: string, active?: SessionSearchMatch | null, reveal?: SearchRevealRequest, align?: AlignInTranscript) {
  measure(() => {
    if (mode !== "baseline") return candidateApply(root, query, active, reveal, align)
    const scroll = Boolean(reveal && !reveal.claimed)
    if (reveal) reveal.claimed = true
    applySearchMarks(root, query, active, scroll)
  })
}
export function clearSearchHighlights(root: HTMLElement) {
  measure(() => mode === "baseline" ? removeSearchMarks(root) : candidateClear(root))
}
