import { applySearchHighlights as candidateApply, clearSearchHighlights as candidateClear } from "../../../src/components/search-highlights"
import { applySearchMarks, removeSearchMarks } from "./search-highlight-baseline"
import type { SessionSearchMatch } from "../../../src/lib/session-search"

export const mode = new URLSearchParams(location.search).get("mode") ?? "css"
export const samples: number[] = []
export let recording = false
export function record(value: boolean) { recording = value; if (value) samples.length = 0 }
function measure(work: () => void) {
  if (!recording) return work()
  const start = performance.now()
  try { work() } finally { samples.push(performance.now() - start) }
}
export function applySearchHighlights(root: HTMLElement, query: string, active?: SessionSearchMatch | null, scroll = false) {
  measure(() => mode === "baseline" ? applySearchMarks(root, query, active, scroll) : candidateApply(root, query, active, scroll))
}
export function clearSearchHighlights(root: HTMLElement) {
  measure(() => mode === "baseline" ? removeSearchMarks(root) : candidateClear(root))
}
