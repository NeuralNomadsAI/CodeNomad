import type { Accessor, JSXElement } from "solid-js"
import type { RenderCache } from "../../types/message"
import type { DiffViewMode } from "../../stores/preferences"
import { ToolCallDiffViewer } from "../diff-viewer"
import type { DiffPayload, DiffRenderOptions, ToolScrollHelpers } from "./types"
import { getRelativePath } from "./utils"
import { getCacheEntry } from "../../lib/global-cache"

type CacheHandle = {
  get<T>(): T | undefined
  params(): unknown
}

type DiffPrefs = {
  diffViewMode?: DiffViewMode
}

export function createDiffContentRenderer(params: {
  preferences: Accessor<DiffPrefs>
  setDiffViewMode: (mode: DiffViewMode) => void
  isDark: Accessor<boolean>
  t: (key: string, params?: Record<string, unknown>) => string
  diffCache: CacheHandle
  permissionDiffCache: CacheHandle
  scrollHelpers: ToolScrollHelpers
  handleScrollRendered: () => void
  onContentRendered?: () => void
}) {
  const registerTracked = (element: HTMLDivElement | null) => {
    params.scrollHelpers.registerContainer(element)
  }

  const registerUntracked = (element: HTMLDivElement | null) => {
    params.scrollHelpers.registerContainer(element, { disableTracking: true })
  }

  function renderDiffContent(payload: DiffPayload, options?: DiffRenderOptions): JSXElement | null {
    const relativePath = payload.filePath ? getRelativePath(payload.filePath) : ""
    const toolbarLabel = options?.label || (relativePath
      ? params.t("toolCall.diff.label.withPath", { path: relativePath })
      : params.t("toolCall.diff.label"))
    const selectedVariant = options?.variant === "permission-diff" ? "permission-diff" : "diff"
    const cacheHandle = selectedVariant === "permission-diff" ? params.permissionDiffCache : params.diffCache
    const diffMode = () => (params.preferences().diffViewMode || "split") as DiffViewMode
    const themeKey = params.isDark() ? "dark" : "light"
    const disableScrollTracking = Boolean(options?.disableScrollTracking)
    const registerRef = disableScrollTracking ? registerUntracked : registerTracked

    const baseEntryParams = cacheHandle.params() as any
    const cacheEntryParams = (() => {
      const suffix = typeof options?.cacheKey === "string" ? options.cacheKey.trim() : ""
      if (!suffix) return baseEntryParams
      return {
        ...baseEntryParams,
        cacheId: `${baseEntryParams.cacheId}:${suffix}`,
      }
    })()

    let cachedHtml: string | undefined
    const cached = getCacheEntry<RenderCache>(cacheEntryParams)
    const currentMode = diffMode()
    if (cached && cached.text === payload.diffText && cached.theme === themeKey && cached.mode === currentMode) {
      cachedHtml = cached.html
    }

    const handleModeChange = (mode: DiffViewMode) => {
      params.setDiffViewMode(mode)
    }

    const handleDiffRendered = () => {
      if (!disableScrollTracking) {
        params.handleScrollRendered()
      }
      params.onContentRendered?.()
    }

    return (
      <div
        class="message-text tool-call-markdown tool-call-markdown-large tool-call-diff-shell"
        ref={registerRef}
        onScroll={disableScrollTracking ? undefined : params.scrollHelpers.handleScroll}
      >
        <div class="tool-call-diff-toolbar" role="group" aria-label={params.t("toolCall.diff.viewMode.ariaLabel")}>
          <span class="tool-call-diff-toolbar-label">{toolbarLabel}</span>
          <div class="tool-call-diff-toggle">
            <button
              type="button"
              class={`tool-call-diff-mode-button${diffMode() === "split" ? " active" : ""}`}
              aria-pressed={diffMode() === "split"}
              onClick={() => handleModeChange("split")}
            >
              {params.t("toolCall.diff.viewMode.split")}
            </button>
            <button
              type="button"
              class={`tool-call-diff-mode-button${diffMode() === "unified" ? " active" : ""}`}
              aria-pressed={diffMode() === "unified"}
              onClick={() => handleModeChange("unified")}
            >
              {params.t("toolCall.diff.viewMode.unified")}
            </button>
          </div>
        </div>
        <ToolCallDiffViewer
          diffText={payload.diffText}
          filePath={payload.filePath}
          theme={themeKey}
          mode={diffMode()}
          cachedHtml={cachedHtml}
          cacheEntryParams={cacheEntryParams as any}
          onRendered={handleDiffRendered}
        />
        {params.scrollHelpers.renderSentinel({ disableTracking: disableScrollTracking })}
      </div>
    )
  }

  return { renderDiffContent }
}
