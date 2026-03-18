import { createMemo, createSignal, Show, createEffect, onMount, onCleanup } from "solid-js"
import { DiffView, DiffModeEnum } from "@git-diff-view/solid"
import { disableCache } from "@git-diff-view/core"
import type { DiffHighlighterLang } from "@git-diff-view/core"
import { ErrorBoundary } from "solid-js"
import { getLanguageFromPath } from "../lib/markdown"
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
  diffText: string
  cacheEntryParams?: CacheEntryParams
}

export function ToolCallDiffViewer(props: ToolCallDiffViewerProps) {
  // Defer mounting the heavy DiffView component until the container is
  // scrolled into view.  When cached HTML is available, skip deferral.
  // This avoids rendering expensive diff tables for off-screen messages
  // during session switches (the old requestIdleCallback approach fired
  // too early when the browser had spare time between tasks).
  const [deferredReady, setDeferredReady] = createSignal(Boolean(props.cachedHtml))
  let sentinelRef: HTMLDivElement | undefined
  onMount(() => {
    if (props.cachedHtml) return
    if (typeof IntersectionObserver === "undefined") {
      setDeferredReady(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setDeferredReady(true)
            observer.disconnect()
            return
          }
        }
      },
      { rootMargin: "200px 0px" },
    )
    if (sentinelRef) observer.observe(sentinelRef)
    onCleanup(() => observer.disconnect())
  })

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
    return `${props.theme}|${props.mode}|${props.diffText}`
  })
 
  createEffect(() => {
    const cachedHtml = props.cachedHtml
    if (cachedHtml) {
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
      const markup = diffContainerRef.innerHTML
      if (!markup) return
      lastCapturedKey = key
      if (props.cacheEntryParams) {
        setCacheEntry(props.cacheEntryParams, {
          text: props.diffText,
          html: markup,
          theme: props.theme,
          mode: props.mode,
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
              when={deferredReady() && diffData()}
              fallback={<div ref={sentinelRef}><pre class="tool-call-diff-fallback">{props.diffText}</pre></div>}
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
                    diffViewWrap={false}
                    diffViewFontSize={13}
                  />
                </ErrorBoundary>
              )}
            </Show>
          </div>
        }
      >
        <div innerHTML={props.cachedHtml} />
      </Show>
    </div>
  )
}