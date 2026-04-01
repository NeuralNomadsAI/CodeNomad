import { Suspense, createEffect, createMemo, createSignal, lazy, onMount, type Accessor, type JSXElement } from "solid-js"
import type { ToolState } from "@opencode-ai/sdk/v2"
import useMediaQuery from "@suid/material/useMediaQuery"
import { AlignJustify, Copy, Split, WrapText } from "lucide-solid"
import type { RenderCache } from "../../types/message"
import type { DiffViewMode } from "../../stores/preferences"
import type { DiffPayload, DiffRenderOptions, ToolScrollHelpers } from "./types"
import { getRelativePath } from "./utils"
import { getCacheEntry } from "../../lib/global-cache"
import { copyToClipboard } from "../../lib/clipboard"

const LazyToolCallDiffViewer = lazy(() =>
  import("../diff-viewer").then((module) => ({ default: module.ToolCallDiffViewer })),
)

function CachedDiffMarkup(props: { html: string; onRendered?: () => void }) {
  onMount(() => {
    props.onRendered?.()
  })

  return (
    <div class="tool-call-diff-viewer">
      <div innerHTML={props.html} />
    </div>
  )
}

type CacheHandle = {
  get<T>(): T | undefined
  params(): unknown
}

type DiffPrefs = {
  diffViewMode?: DiffViewMode
}

export function createDiffContentRenderer(params: {
  toolState: Accessor<ToolState | undefined>
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
  const compactDiffQuery = useMediaQuery("(max-width: 640px)")
  const [mobileModeOverride, setMobileModeOverride] = createSignal<DiffViewMode | undefined>(undefined)
  const [wordWrapEnabled, setWordWrapEnabled] = createSignal(true)

  createEffect(() => {
    if (!compactDiffQuery()) {
      setMobileModeOverride(undefined)
    }
  })

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
    const preferredMode = () => (params.preferences().diffViewMode || "split") as DiffViewMode
    const effectiveMode = () => {
      if (!compactDiffQuery()) return preferredMode()
      return mobileModeOverride() || "unified"
    }
    const shouldWrap = () => wordWrapEnabled()
    const themeKey = params.isDark() ? "dark" : "light"
    const state = params.toolState()
    const disableScrollTracking = Boolean(
      options?.disableScrollTracking || (state?.status !== "running" && state?.status !== "pending"),
    )
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

    const currentMode = createMemo(() => effectiveMode())
    const currentWrap = createMemo(() => shouldWrap())
    const cachedHtml = createMemo(() => {
      const cached = getCacheEntry<RenderCache>(cacheEntryParams)
      if (
        cached
        && cached.text === payload.diffText
        && cached.theme === themeKey
        && cached.mode === currentMode()
        && cached.wrap === currentWrap()
      ) {
        return cached.html
      }
      return undefined
    })

    const handleModeChange = (mode: DiffViewMode) => {
      if (compactDiffQuery()) {
        setMobileModeOverride(mode)
      }
      params.setDiffViewMode(mode)
    }

    const nextViewMode = (): DiffViewMode => (currentMode() === "split" ? "unified" : "split")
    const viewModeTitle = () =>
      nextViewMode() === "split"
        ? params.t("toolCall.diff.switchToSplit")
        : params.t("toolCall.diff.switchToUnified")
    const wordWrapTitle = () =>
      wordWrapEnabled()
        ? params.t("toolCall.diff.disableWordWrap")
        : params.t("toolCall.diff.enableWordWrap")
    const copyPatchTitle = () => params.t("toolCall.diff.copyPatch")

    const handleDiffRendered = () => {
      if (!disableScrollTracking) {
        params.handleScrollRendered()
      }
      params.onContentRendered?.()
    }

    return (
        <div
          class="message-text tool-call-markdown tool-call-markdown-large tool-call-diff-shell"
          data-diff-mode={currentMode()}
          ref={registerRef}
          onScroll={disableScrollTracking ? undefined : params.scrollHelpers.handleScroll}
        >
        <div class="tool-call-diff-toolbar" role="group" aria-label={params.t("toolCall.diff.viewMode.ariaLabel")}>
          <span class="tool-call-diff-toolbar-label">{toolbarLabel}</span>
          <div class="file-viewer-toolbar">
            <button
              type="button"
              class="file-viewer-toolbar-icon-button"
              onClick={() => void copyToClipboard(payload.diffText)}
              aria-label={copyPatchTitle()}
              title={copyPatchTitle()}
            >
              <Copy class="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              class="file-viewer-toolbar-icon-button"
              onClick={() => handleModeChange(nextViewMode())}
              aria-label={viewModeTitle()}
              title={viewModeTitle()}
            >
              {nextViewMode() === "split" ? <Split class="h-4 w-4" aria-hidden="true" /> : <AlignJustify class="h-4 w-4" aria-hidden="true" />}
            </button>
            <button
              type="button"
              class={`file-viewer-toolbar-icon-button${wordWrapEnabled() ? " active" : ""}`}
              onClick={() => setWordWrapEnabled((enabled) => !enabled)}
              aria-label={wordWrapTitle()}
              title={wordWrapTitle()}
            >
              <WrapText class="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>
        {cachedHtml() ? (
          <CachedDiffMarkup html={cachedHtml()!} onRendered={handleDiffRendered} />
        ) : (
          <Suspense fallback={<pre class="tool-call-diff-fallback">{payload.diffText}</pre>}>
            <LazyToolCallDiffViewer
              diffText={payload.diffText}
              filePath={payload.filePath}
              theme={themeKey}
              mode={currentMode()}
              wrap={currentWrap()}
              cacheEntryParams={cacheEntryParams as any}
              onRendered={handleDiffRendered}
            />
          </Suspense>
        )}
        {params.scrollHelpers.renderSentinel({ disableTracking: disableScrollTracking })}
      </div>
    )
  }

  return { renderDiffContent }
}
