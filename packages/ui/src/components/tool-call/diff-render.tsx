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
  diffCache: CacheHandle
  permissionDiffCache: CacheHandle
  scrollHelpers: ToolScrollHelpers
  handleScrollRendered: () => void
  onContentRendered?: () => void
}) {
  function renderDiffContent(payload: DiffPayload, options?: DiffRenderOptions): JSXElement | null {
    const relativePath = payload.filePath ? getRelativePath(payload.filePath) : ""
    const toolbarLabel = options?.label || (relativePath ? `Diff · ${relativePath}` : "Diff")
    const selectedVariant = options?.variant === "permission-diff" ? "permission-diff" : "diff"
    const cacheHandle = selectedVariant === "permission-diff" ? params.permissionDiffCache : params.diffCache
    const diffMode = () => (params.preferences().diffViewMode || "split") as DiffViewMode
    const themeKey = params.isDark() ? "dark" : "light"

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
      if (!options?.disableScrollTracking) {
        params.handleScrollRendered()
      }
      params.onContentRendered?.()
    }

    return (
      <div
        class="message-text tool-call-markdown tool-call-markdown-large tool-call-diff-shell"
        ref={(element) => params.scrollHelpers.registerContainer(element, { disableTracking: options?.disableScrollTracking })}
        onScroll={options?.disableScrollTracking ? undefined : params.scrollHelpers.handleScroll}
      >
        <div class="tool-call-diff-toolbar" role="group" aria-label="Diff view mode">
          <span class="tool-call-diff-toolbar-label">{toolbarLabel}</span>
          <div class="tool-call-diff-toggle">
            <button
              type="button"
              class={`tool-call-diff-mode-button${diffMode() === "split" ? " active" : ""}`}
              aria-pressed={diffMode() === "split"}
              onClick={() => handleModeChange("split")}
            >
              Split
            </button>
            <button
              type="button"
              class={`tool-call-diff-mode-button${diffMode() === "unified" ? " active" : ""}`}
              aria-pressed={diffMode() === "unified"}
              onClick={() => handleModeChange("unified")}
            >
              Unified
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
        {params.scrollHelpers.renderSentinel({ disableTracking: options?.disableScrollTracking })}
      </div>
    )
  }

  return { renderDiffContent }
}
