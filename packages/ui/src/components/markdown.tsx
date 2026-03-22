import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useGlobalCache } from "../lib/hooks/use-global-cache"
import type { TextPart, RenderCache } from "../types/message"
import { getLogger } from "../lib/logger"
import { copyToClipboard } from "../lib/clipboard"
import { useI18n } from "../lib/i18n"

const log = getLogger("session")

type MarkdownModule = typeof import("../lib/markdown")

let markdownModulePromise: Promise<MarkdownModule> | null = null

function loadMarkdownModule(): Promise<MarkdownModule> {
  if (!markdownModulePromise) {
    markdownModulePromise = import("../lib/markdown").catch((error) => {
      markdownModulePromise = null
      throw error
    })
  }
  return markdownModulePromise
}

function hashText(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

function resolvePartVersion(part: TextPart, text: string): string {
  if (typeof part.version === "number") {
    return String(part.version)
  }
  return `text-${hashText(text)}`
}

function resolvePartCacheId(part: TextPart, text: string): string {
  const partId = typeof part.id === "string" && part.id.length > 0 ? part.id : ""
  if (partId) {
    return partId
  }

  return `anonymous:${hashText(text)}`
}

function decodeHtmlEntitiesLocally(content: string): string {
  if (!content.includes("&") || typeof document === "undefined") {
    return content
  }

  const textarea = document.createElement("textarea")
  textarea.innerHTML = content
  return textarea.value
}

function escapeHtml(content: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }

  return content.replace(/[&<>"']/g, (match) => map[match] ?? match)
}

function renderFallbackHtml(content: string): string {
  if (!content) {
    return ""
  }

  return escapeHtml(content).replace(/\n/g, "<br />")
}

interface MarkdownProps {
  part: TextPart
  instanceId?: string
  sessionId?: string
  isDark?: boolean
  size?: "base" | "sm" | "tight"
  disableHighlight?: boolean
  onRendered?: () => void
}

export function Markdown(props: MarkdownProps) {
  const { t } = useI18n()
  const [html, setHtml] = createSignal("")
  let containerRef: HTMLDivElement | undefined
  let latestRequestKey = ""
  let cleanupLanguageListener: (() => void) | undefined

  const notifyRendered = () => {
    Promise.resolve().then(() => props.onRendered?.())
  }

  const resolved = createMemo(() => {
    const part = props.part
    const rawText = typeof part.text === "string" ? part.text : ""
    const text = decodeHtmlEntitiesLocally(rawText)
    const themeKey = Boolean(props.isDark) ? "dark" : "light"
    const highlightEnabled = !props.disableHighlight
    const partId = typeof part.id === "string" && part.id.length > 0 ? part.id : undefined
    const cacheId = resolvePartCacheId(part, text)
    const version = resolvePartVersion(part, text)
    const requestKey = `${cacheId}:${themeKey}:${highlightEnabled ? 1 : 0}:${version}`
    return { part, text, themeKey, highlightEnabled, partId, cacheId, version, requestKey }
  })

  const cacheHandle = useGlobalCache({
    instanceId: () => props.instanceId,
    sessionId: () => props.sessionId,
    scope: "markdown",
    cacheId: () => {
      const { cacheId, themeKey, highlightEnabled } = resolved()
      return `${cacheId}:${themeKey}:${highlightEnabled ? 1 : 0}`
    },
    version: () => resolved().version,
  })

  const commitCacheEntry = (snapshot: ReturnType<typeof resolved>, renderedHtml: string) => {
    const cacheEntry: RenderCache = {
      text: snapshot.text,
      html: renderedHtml,
      theme: snapshot.themeKey,
      mode: snapshot.version,
    }
    setHtml(renderedHtml)
    cacheHandle.set(cacheEntry)
    notifyRendered()
  }

  const renderSnapshot = async (snapshot: ReturnType<typeof resolved>) => {
    const markdown = await loadMarkdownModule()
    markdown.setMarkdownTheme(snapshot.themeKey === "dark")
    const rendered = await markdown.renderMarkdown(snapshot.text, {
      suppressHighlight: !snapshot.highlightEnabled,
    })

    if (latestRequestKey === snapshot.requestKey) {
      commitCacheEntry(snapshot, rendered)
    }
  }

  createEffect(() => {
    const snapshot = resolved()
    latestRequestKey = snapshot.requestKey

    const cacheMatches = (cache: RenderCache | undefined) => {
      if (!cache) return false
      return cache.theme === snapshot.themeKey && cache.mode === snapshot.version
    }

    const localCache = snapshot.part.renderCache
    if (localCache && cacheMatches(localCache)) {
      setHtml(localCache.html)
      notifyRendered()
      return
    }

    const globalCache = cacheHandle.get<RenderCache>()
    if (globalCache && cacheMatches(globalCache)) {
      setHtml(globalCache.html)
      notifyRendered()
      return
    }

    setHtml(renderFallbackHtml(snapshot.text))
    notifyRendered()

    void renderSnapshot(snapshot).catch((error) => {
      log.error("Failed to render markdown:", error)
      if (latestRequestKey === snapshot.requestKey) {
        commitCacheEntry(snapshot, renderFallbackHtml(snapshot.text))
      }
    })
  })

  onMount(() => {
    const handleClick = async (event: Event) => {
      const target = event.target as HTMLElement
      const copyButton = target.closest(".code-block-copy") as HTMLButtonElement

      if (!copyButton) {
        return
      }

      event.preventDefault()
      const code = copyButton.getAttribute("data-code")
      if (!code) {
        return
      }

      const decodedCode = decodeURIComponent(code)
      const success = await copyToClipboard(decodedCode)
      const copyText = copyButton.querySelector(".copy-text")
      if (!copyText) {
        return
      }

      copyText.textContent = success ? t("markdown.codeBlock.copy.copied") : t("markdown.codeBlock.copy.failed")
      setTimeout(() => {
        copyText.textContent = t("markdown.codeBlock.copy.label")
      }, 2000)
    }

    containerRef?.addEventListener("click", handleClick)

    let disposed = false
    void loadMarkdownModule()
      .then((markdown) => {
        if (disposed) {
          return
        }

        cleanupLanguageListener = markdown.onLanguagesLoaded(() => {
          const snapshot = resolved()
          if (!snapshot.highlightEnabled) {
            return
          }

          latestRequestKey = snapshot.requestKey
          void renderSnapshot(snapshot).catch((error) => {
            log.error("Failed to re-render markdown after language load:", error)
          })
        })
      })
      .catch((error) => {
        log.error("Failed to load markdown module:", error)
      })

    onCleanup(() => {
      disposed = true
      containerRef?.removeEventListener("click", handleClick)
      cleanupLanguageListener?.()
      cleanupLanguageListener = undefined
    })
  })

  return (
    <div
      ref={containerRef}
      class="markdown-body"
      data-view="markdown"
      data-part-id={resolved().partId}
      data-markdown-theme={resolved().themeKey}
      data-markdown-highlight={resolved().highlightEnabled ? "true" : "false"}
      innerHTML={html()}
    />
  )
}
