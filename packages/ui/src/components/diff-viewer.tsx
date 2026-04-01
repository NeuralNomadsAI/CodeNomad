import { createMemo, Show, createEffect, onCleanup } from "solid-js"
import { DiffView, DiffModeEnum } from "@git-diff-view/solid"
import "@git-diff-view/solid/styles/diff-view-pure.css"
import { disableCache } from "@git-diff-view/core"
import type { DiffHighlighterLang } from "@git-diff-view/core"
import { ErrorBoundary } from "solid-js"
import { getLanguageFromPath } from "../lib/text-render-utils"
import { normalizeDiffText } from "../lib/diff-utils"
import { setCacheEntry } from "../lib/global-cache"
import type { CacheEntryParams } from "../lib/global-cache"
import type { DiffViewMode } from "../stores/preferences"
import { getLogger } from "../lib/logger"
const log = getLogger("session")


disableCache()

interface ToolCallDiffViewerProps {
  diffText: string
  filePath?: string
  theme: "light" | "dark"
  mode: DiffViewMode
  wrap?: boolean
  compactDiffLayout?: boolean
  onRendered?: () => void
  cachedHtml?: string
  cacheEntryParams?: CacheEntryParams
}

type DiffData = {
  oldFile?: { fileName?: string | null; fileLang?: string | null; content?: string | null }
  newFile?: { fileName?: string | null; fileLang?: string | null; content?: string | null }
  hunks: string[]
}

type CaptureContext = {
  theme: ToolCallDiffViewerProps["theme"]
  mode: DiffViewMode
  wrap?: boolean
  compactDiffLayout?: boolean
  diffText: string
  cacheEntryParams?: CacheEntryParams
}

function measureTextWidth(container: HTMLElement, text: string, source: HTMLElement) {
  const computed = window.getComputedStyle(source)
  const probe = document.createElement("span")
  probe.textContent = text || ""
  probe.style.position = "absolute"
  probe.style.visibility = "hidden"
  probe.style.pointerEvents = "none"
  probe.style.display = "inline-block"
  probe.style.width = "auto"
  probe.style.maxWidth = "none"
  probe.style.whiteSpace = "nowrap"
  probe.style.fontFamily = computed.fontFamily
  probe.style.fontSize = computed.fontSize
  probe.style.fontWeight = computed.fontWeight
  probe.style.fontStyle = computed.fontStyle
  probe.style.letterSpacing = computed.letterSpacing
  probe.style.fontVariant = computed.fontVariant
  probe.style.textTransform = computed.textTransform
  probe.style.lineHeight = computed.lineHeight
  container.appendChild(probe)
  const width = Math.ceil(probe.getBoundingClientRect().width)
  probe.remove()
  return width
}

function computeCompactWidth(container: HTMLElement, entries: Array<{ text: string; source: HTMLElement }>) {
  const measuredLabelWidthPx = entries.reduce((max, entry) => {
    return Math.max(max, measureTextWidth(container, entry.text, entry.source))
  }, 0)
  const fallbackTextLength = entries.reduce((max, entry) => Math.max(max, entry.text.length), 1)
  const fallbackWidthPx = Math.round(fallbackTextLength * 7 + 4)
  return Math.max(2, Math.min(40, measuredLabelWidthPx > 0 ? measuredLabelWidthPx + 2 : fallbackWidthPx))
}

function applyCompactUnifiedGutter(container: HTMLElement) {
  const tableWrapper = container.querySelector<HTMLElement>(".unified-diff-table-wrapper")
  const table = container.querySelector<HTMLTableElement>(".unified-diff-table")
  const numberCol = container.querySelector<HTMLTableColElement>(".unified-diff-table-num-col")
  const gutterRows = container.querySelectorAll<HTMLElement>(".diff-line-num")
  const hunkGutters = container.querySelectorAll<HTMLElement>(".diff-line-hunk-action, .diff-line-widget-wrapper, .diff-line-extend-wrapper")
  const entries: Array<{ gutter: HTMLElement; label: HTMLElement; text: string }> = []

  if (table) {
    table.classList.add("table-fixed")
    table.style.tableLayout = "fixed"
  }

  gutterRows.forEach((gutter) => {
    const oldSpan = gutter.querySelector<HTMLElement>("[data-line-old-num]")
    const newSpan = gutter.querySelector<HTMLElement>("[data-line-new-num]")
    const spacer = gutter.querySelector<HTMLElement>(".shrink-0")
    const flexWrapper = gutter.querySelector<HTMLElement>(":scope > .flex")
    const currentLabel = gutter.querySelector<HTMLElement>(":scope > .tool-call-diff-compact-line-number")

    const oldText = oldSpan?.textContent?.trim() ?? ""
    const newText = newSpan?.textContent?.trim() ?? ""
    const hasUsableNew = newText.length > 0 && newText !== "0"
    const hasUsableOld = oldText.length > 0 && oldText !== "0"
    const visibleText = hasUsableNew ? newText : hasUsableOld ? oldText : newText || oldText

    if (flexWrapper) flexWrapper.style.display = "none"
    if (spacer) spacer.style.display = "none"
    if (oldSpan) { oldSpan.style.display = "none"; oldSpan.style.width = "auto" }
    if (newSpan) { newSpan.style.display = "none"; newSpan.style.width = "auto" }

    gutter.style.paddingLeft = "1px"
    gutter.style.paddingRight = "1px"
    gutter.style.textAlign = "left"

    const label = currentLabel ?? document.createElement("span")
    label.className = "tool-call-diff-compact-line-number"
    label.textContent = visibleText
    label.setAttribute("aria-hidden", visibleText ? "false" : "true")
    if (!currentLabel) gutter.appendChild(label)

    entries.push({ gutter, label, text: visibleText })
  })

  const gutterWidthPx = computeCompactWidth(container, entries.map((entry) => ({ text: entry.text, source: entry.label })))
  const gutterWidth = `${gutterWidthPx}px`
  const compactAsideWidth = `${Math.max(8, gutterWidthPx - 10)}px`

  if (tableWrapper) {
    tableWrapper.style.setProperty("--diff-aside-width", compactAsideWidth)
    tableWrapper.style.setProperty("--diff-aside-width--", compactAsideWidth)
  }
  if (numberCol) {
    numberCol.style.width = gutterWidth
  }

  entries.forEach(({ gutter, label }) => {
    gutter.style.width = gutterWidth
    gutter.style.minWidth = gutterWidth
    gutter.style.maxWidth = gutterWidth
    label.style.width = "auto"
    label.style.maxWidth = "none"
  })

  hunkGutters.forEach((gutter) => {
    gutter.style.width = gutterWidth
    gutter.style.minWidth = gutterWidth
    gutter.style.maxWidth = gutterWidth
    gutter.style.paddingLeft = "0"
    gutter.style.paddingRight = "0"
  })
}

function applyCompactSplitGutter(container: HTMLElement) {
  const oldWrapper = container.querySelector<HTMLElement>(".old-diff-table-wrapper")
  const newWrapper = container.querySelector<HTMLElement>(".new-diff-table-wrapper")
  const numberCells = Array.from(container.querySelectorAll<HTMLElement>(".diff-line-old-num, .diff-line-new-num"))
  const hunkActions = Array.from(container.querySelectorAll<HTMLElement>(".diff-line-hunk-action, .diff-line-widget-wrapper, .diff-line-extend-wrapper"))
  const numberSpans = numberCells
    .map((cell) => ({ cell, span: cell.querySelector<HTMLElement>("[data-line-num]") }))
    .filter((entry): entry is { cell: HTMLElement; span: HTMLElement } => Boolean(entry.span))

  const gutterWidthPx = computeCompactWidth(container, numberSpans.map(({ span }) => ({ text: span.textContent?.trim() ?? "", source: span })))
  const gutterWidth = `${gutterWidthPx}px`

  ;[oldWrapper, newWrapper].forEach((wrapper) => {
    if (wrapper) {
      wrapper.style.setProperty("--diff-aside-width", gutterWidth)
    }
  })

  numberCells.forEach((cell) => {
    cell.style.width = gutterWidth
    cell.style.minWidth = gutterWidth
    cell.style.maxWidth = gutterWidth
    cell.style.paddingLeft = "2px"
    cell.style.paddingRight = "2px"
    cell.style.textAlign = "left"
  })

  hunkActions.forEach((cell) => {
    cell.style.width = gutterWidth
    cell.style.minWidth = gutterWidth
    cell.style.maxWidth = gutterWidth
    cell.style.paddingLeft = "0"
    cell.style.paddingRight = "0"
  })
}

function applyCompactDiffLayout(container: HTMLElement, mode: DiffViewMode) {
  if (mode === "unified") {
    applyCompactUnifiedGutter(container)
    return
  }
  if (mode === "split") {
    applyCompactSplitGutter(container)
  }
}

export function ToolCallDiffViewer(props: ToolCallDiffViewerProps) {
  const diffData = createMemo<DiffData | null>(() => {
    const normalized = normalizeDiffText(props.diffText)
    if (!normalized) {
      return null
    }
 
    const language = getLanguageFromPath(props.filePath) || "text"
    const fileName = props.filePath || "diff"
 
    return {
      oldFile: {
        fileName,
        fileLang: (language || "text") as DiffHighlighterLang | null,
      },
      newFile: {
        fileName,
        fileLang: (language || "text") as DiffHighlighterLang | null,
      },
      hunks: [normalized],
    }
  })
 
  let diffContainerRef: HTMLDivElement | undefined
  let lastCapturedKey: string | undefined
 
  const contextKey = createMemo(() => {
    const data = diffData()
    if (!data) return ""
    return `${props.theme}|${props.mode}|${props.wrap ? "wrap" : "nowrap"}|${props.compactDiffLayout ? "compact" : "regular"}|${props.diffText}`
  })
 
  createEffect(() => {
    const cachedHtml = props.cachedHtml
    if (cachedHtml) {
      if (props.compactDiffLayout && diffContainerRef) {
        applyCompactDiffLayout(diffContainerRef, props.mode)
      }
      // When we are given cached HTML, we rely on the caller's cache
      // and simply notify once rendered.
      props.onRendered?.()
      return
    }
 
    const key = contextKey()
    if (!key) return
    if (!diffContainerRef) return
    if (lastCapturedKey === key) return

    requestAnimationFrame(() => {
      if (!diffContainerRef) return
      if (props.compactDiffLayout) {
        applyCompactDiffLayout(diffContainerRef, props.mode)
      }
      const markup = diffContainerRef.innerHTML
      if (!markup) return
      lastCapturedKey = key
      if (props.cacheEntryParams) {
        setCacheEntry(props.cacheEntryParams, {
          text: props.diffText,
          html: markup,
          theme: props.theme,
          mode: props.mode,
          wrap: props.wrap,
          compactDiffLayout: props.compactDiffLayout,
        })
      }
      props.onRendered?.()
    })
  })


  return (
    <div class="tool-call-diff-viewer">
      <Show
        when={props.cachedHtml}
        fallback={
          <div ref={diffContainerRef}>
            <Show
              when={diffData()}
              fallback={<pre class="tool-call-diff-fallback">{props.diffText}</pre>}
            >
              {(data) => (
                <ErrorBoundary fallback={(error) => {
                  log.warn("Failed to render diff view", error)
                  return <pre class="tool-call-diff-fallback">{props.diffText}</pre>
                }}>
                  <DiffView
                    data={data()}
                    diffViewMode={props.mode === "split" ? DiffModeEnum.Split : DiffModeEnum.Unified}
                    diffViewTheme={props.theme}
                    diffViewHighlight
                    diffViewWrap={Boolean(props.wrap)}
                    diffViewFontSize={13}
                  />
                </ErrorBoundary>
              )}
            </Show>
          </div>
        }
      >
        <div ref={diffContainerRef} innerHTML={props.cachedHtml} />
      </Show>
    </div>
  )
}
