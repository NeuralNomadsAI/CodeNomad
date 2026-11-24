import { Show, createSignal, onCleanup } from "solid-js"
import { ChevronLeft, ChevronRight, Copy } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import { copyToClipboard } from "../lib/clipboard"
import { TOOL_OUTPUT_RENDER_CHARACTER_LIMIT, getRelativePath } from "./tool-call/utils"
import type { PermissionDiffReview } from "./permission-diff-review"

/** Full source is accessible in fixed-size pages, never mounted as one huge DOM node. */
export function PermissionFallbackDiff(props: { review: PermissionDiffReview }) {
  const { t } = useI18n()
  const [page, setPage] = createSignal(0)
  const [copying, setCopying] = createSignal(false)
  const [copyStatus, setCopyStatus] = createSignal("")
  let scrollContainer: HTMLDivElement | undefined
  let disposed = false
  onCleanup(() => { disposed = true })
  const text = () => props.review.payload.diffText
  const pageCount = () => Math.max(1, Math.ceil(text().length / TOOL_OUTPUT_RENDER_CHARACTER_LIMIT))
  const pageText = () => text().slice(page() * TOOL_OUTPUT_RENDER_CHARACTER_LIMIT, (page() + 1) * TOOL_OUTPUT_RENDER_CHARACTER_LIMIT)
  const showPage = (index: number) => {
    setPage(index)
    if (scrollContainer) scrollContainer.scrollTop = 0
  }
  const nextPage = () => {
    const next = Math.min(page() + 1, pageCount() - 1)
    showPage(next)
    // Navigation is sequential: reaching the final page exposes every character.
    if (next === pageCount() - 1) props.review.complete()
  }
  const copy = async () => {
    if (copying()) return
    const review = props.review
    setCopying(true)
    setCopyStatus("")
    const copied = await copyToClipboard(review.payload.diffText)
    if (disposed || props.review !== review) return
    setCopying(false)
    setCopyStatus(t(copied ? "markdown.codeBlock.copy.copied" : "messageSection.quote.copyFailed"))
    if (copied) review.complete()
  }

  return <div class="tool-call-permission-diff">
    <div ref={scrollContainer} class="message-text tool-call-markdown tool-call-markdown-large tool-call-diff-shell">
      <div class="tool-call-diff-toolbar" role="group" aria-label={t("toolCall.permission.requestedDiff.label")}>
        <span class="tool-call-diff-toolbar-label">{props.review.payload.filePath
          ? t("toolCall.permission.requestedDiff.withPath", { path: getRelativePath(props.review.payload.filePath!) })
          : t("toolCall.permission.requestedDiff.label")}</span>
        <div class="file-viewer-toolbar">
          <button type="button" class="file-viewer-toolbar-icon-button" disabled={copying()} onClick={() => void copy()}
            aria-label={t("toolCall.diff.copyPatch")} title={t("toolCall.diff.copyPatch")}>
            <Copy class="h-4 w-4" aria-hidden="true" />
          </button>
          <Show when={pageCount() > 1}>
            <button type="button" class="file-viewer-toolbar-icon-button" disabled={page() === 0} onClick={() => showPage(page() - 1)}
              aria-label={t("toolCall.permission.diff.previous")} title={t("toolCall.permission.diff.previous")}>
              <ChevronLeft class="h-4 w-4" aria-hidden="true" />
            </button>
            <span>{t("toolCall.permission.diff.page", { page: page() + 1, total: pageCount() })}</span>
            <button type="button" class="file-viewer-toolbar-icon-button" disabled={page() === pageCount() - 1} onClick={nextPage}
              aria-label={t("toolCall.permission.diff.next")} title={t("toolCall.permission.diff.next")}>
              <ChevronRight class="h-4 w-4" aria-hidden="true" />
            </button>
          </Show>
        </div>
      </div>
      <Show when={pageCount() > 1 && !props.review.reviewed()}>
        <p class="tool-call-permission-queued-text">{t("toolCall.permission.diff.reviewRequired")}</p>
      </Show>
      <Show when={copyStatus()}><p role="status">{copyStatus()}</p></Show>
      <pre class="tool-call-diff-fallback">{pageText()}</pre>
    </div>
  </div>
}
