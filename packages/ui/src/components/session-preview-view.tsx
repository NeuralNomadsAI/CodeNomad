import { createSignal, type Component } from "solid-js"
import { X } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import { showPromptDialog } from "../stores/alerts"
import type { SessionPreviewRecord } from "../stores/session-previews"
import { BrowserFrame, type BrowserFrameElementTarget } from "./browser-frame"

interface SessionPreviewViewProps {
  preview: SessionPreviewRecord
  onBackToChat: () => void
  onClose: () => void
  onInsertComment: (markdown: string) => void
}

function describeElement(target: BrowserFrameElementTarget): string {
  const label = target.ariaLabel || target.text
  const role = target.role ? ` role="${target.role}"` : ""
  return label ? `${target.tagName}${role} "${label}"` : `${target.tagName}${role}`
}

function buildCommentMarkdown(target: BrowserFrameElementTarget, comment: string): string {
  const lines = [
    "> Web preview comment",
    `> Page: \`${target.pagePath}\``,
    `> Element: \`${describeElement(target)}\``,
  ]
  if (target.selector) {
    lines.push(`> Selector: \`${target.selector}\``)
  }
  return `${lines.join("\n")}\n\n${comment}\n\n`
}

export const SessionPreviewView: Component<SessionPreviewViewProps> = (props) => {
  const { t } = useI18n()
  const [commentMode, setCommentMode] = createSignal(false)
  const target = () => new URL(props.preview.targetUrl)

  async function handleCommentTarget(elementTarget: BrowserFrameElementTarget) {
    const comment = await showPromptDialog(t("sessionPreview.comment.prompt"), {
      title: t("sessionPreview.comment.title"),
      inputLabel: t("sessionPreview.comment.label"),
      confirmLabel: t("sessionPreview.comment.add"),
      cancelLabel: t("sessionPreview.comment.cancel"),
    })
    const normalized = comment?.trim()
    if (!normalized) return
    props.onInsertComment(buildCommentMarkdown(elementTarget, normalized))
  }

  return (
    <div class="flex h-full min-h-0 flex-col bg-surface">
      <div class="flex shrink-0 items-center justify-between gap-3 px-3 py-2" style={{ "border-bottom": "1px solid var(--border-base)" }}>
        <div class="min-w-0">
          <div class="text-sm font-medium text-primary truncate">{t("sessionPreview.title")}</div>
          <div class="text-xs text-muted truncate">{props.preview.targetUrl}</div>
        </div>
        <div class="flex items-center gap-2">
          <button type="button" class="selector-button selector-button-secondary" onClick={props.onBackToChat}>
            {t("sessionPreview.backToChat")}
          </button>
          <button type="button" class="new-tab-button" onClick={props.onClose} aria-label={t("sessionPreview.close")} title={t("sessionPreview.close")}>
            <X class="h-4 w-4" />
          </button>
        </div>
      </div>
      <BrowserFrame
        title={t("sessionPreview.title")}
        initialUrl={props.preview.proxyUrl}
        proxyBasePath={`/previews/${encodeURIComponent(props.preview.token)}`}
        lockedBaseLabel={target().host}
        labels={{
          back: t("sidecars.back"),
          refresh: t("sidecars.refresh"),
          path: t("sidecars.path"),
          go: t("sidecars.go"),
          viewport: t("browserFrame.viewport"),
          viewportResponsive: t("browserFrame.viewport.responsive"),
          viewportDesktop: t("browserFrame.viewport.desktop"),
          viewportTablet: t("browserFrame.viewport.tablet"),
          viewportTabletLandscape: t("browserFrame.viewport.tabletLandscape"),
          viewportMobile: t("browserFrame.viewport.mobile"),
          viewportMobileLandscape: t("browserFrame.viewport.mobileLandscape"),
          commentMode: t("sessionPreview.comment.mode"),
        }}
        commentMode={commentMode()}
        onToggleCommentMode={() => setCommentMode((value) => !value)}
        onCommentTarget={(target) => void handleCommentTarget(target)}
      />
    </div>
  )
}
