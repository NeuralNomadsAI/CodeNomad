import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { renderMarkdown, onLanguagesLoaded, decodeHtmlEntities, setMarkdownTheme } from "../lib/markdown"
import { useGlobalCache } from "../lib/hooks/use-global-cache"
import type { TextPart, RenderCache } from "../types/message"
import { getLogger } from "../lib/logger"
import { copyToClipboard } from "../lib/clipboard"
import { useI18n } from "../lib/i18n"

const log = getLogger("session")

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
  let latestRequestedText = ""

  const notifyRendered = () => {
    Promise.resolve().then(() => props.onRendered?.())
  }

  const resolved = createMemo(() => {
    const part = props.part
    const rawText = typeof part.text === "string" ? part.text : ""
    const text = decodeHtmlEntities(rawText)
    const themeKey = Boolean(props.isDark) ? "dark" : "light"
    const highlightEnabled = !props.disableHighlight
    const partId = typeof part.id === "string" && part.id.length > 0 ? part.id : ""
    if (!partId) {
      throw new Error("Markdown rendering requires a part id")
    }
    const version = resolvePartVersion(part, text)
    return { part, text, themeKey, highlightEnabled, partId, version }
  })

  const cacheHandle = useGlobalCache({
    instanceId: () => props.instanceId,
    sessionId: () => props.sessionId,
    scope: "markdown",
    cacheId: () => {
      const { partId, themeKey, highlightEnabled } = resolved()
      return `${partId}:${themeKey}:${highlightEnabled ? 1 : 0}`
    },
    version: () => resolved().version,
  })

  createEffect(async () => {
    const { part, text, themeKey, highlightEnabled, version } = resolved()

    // Ensure the markdown highlighter theme matches the active UI theme.
    setMarkdownTheme(themeKey === "dark")

    latestRequestedText = text

    const cacheMatches = (cache: RenderCache | undefined) => {
      if (!cache) return false
      return cache.theme === themeKey && cache.mode === version
    }

    const localCache = part.renderCache
    if (localCache && cacheMatches(localCache)) {
      setHtml(localCache.html)
      notifyRendered()
      return
    }

    const globalCache = cacheHandle.get<RenderCache>()
    if (globalCache && cacheMatches(globalCache)) {
      setHtml(globalCache.html)
      part.renderCache = globalCache
      notifyRendered()
      return
    }

    const commitCacheEntry = (renderedHtml: string) => {
      const cacheEntry: RenderCache = { text, html: renderedHtml, theme: themeKey, mode: version }
      setHtml(renderedHtml)
      part.renderCache = cacheEntry
      cacheHandle.set(cacheEntry)
      notifyRendered()
    }

    if (!highlightEnabled) {
      part.renderCache = undefined

      try {
        const rendered = await renderMarkdown(text, { suppressHighlight: true })

        if (latestRequestedText === text) {
          commitCacheEntry(rendered)
        }
      } catch (error) {
        log.error("Failed to render markdown:", error)
        if (latestRequestedText === text) {
          commitCacheEntry(text)
        }
      }
      return
    }

    try {
      const rendered = await renderMarkdown(text)
      if (latestRequestedText === text) {
        commitCacheEntry(rendered)
      }
    } catch (error) {
      log.error("Failed to render markdown:", error)
      if (latestRequestedText === text) {
        commitCacheEntry(text)
      }
    }
  })

  onMount(() => {
    const handleClick = async (e: Event) => {
      const target = e.target as HTMLElement
      const copyButton = target.closest(".code-block-copy") as HTMLButtonElement

      if (copyButton) {
        e.preventDefault()
        const code = copyButton.getAttribute("data-code")
        if (code) {
          const decodedCode = decodeURIComponent(code)
          const success = await copyToClipboard(decodedCode)
          const copyText = copyButton.querySelector(".copy-text")
          if (copyText) {
            if (success) {
              copyText.textContent = t("markdown.codeBlock.copy.copied")
              setTimeout(() => {
                copyText.textContent = t("markdown.codeBlock.copy.label")
              }, 2000)
            } else {
              copyText.textContent = t("markdown.codeBlock.copy.failed")
              setTimeout(() => {
                copyText.textContent = t("markdown.codeBlock.copy.label")
              }, 2000)
            }
          }
        }
      }
    }

    containerRef?.addEventListener("click", handleClick)

    const cleanupLanguageListener = onLanguagesLoaded(async () => {
      if (props.disableHighlight) {
        return
      }

      const { part, text, themeKey, version } = resolved()

      setMarkdownTheme(themeKey === "dark")

      if (latestRequestedText !== text) {
        return
      }

      try {
        const rendered = await renderMarkdown(text)
        if (latestRequestedText === text) {
          const cacheEntry: RenderCache = { text, html: rendered, theme: themeKey, mode: version }
          setHtml(rendered)
          part.renderCache = cacheEntry
          cacheHandle.set(cacheEntry)
          notifyRendered()
        }
      } catch (error) {
        log.error("Failed to re-render markdown after language load:", error)
      }
    })

    onCleanup(() => {
      containerRef?.removeEventListener("click", handleClick)
      cleanupLanguageListener()
    })
  })

  const proseClass = () => "markdown-body"

  return <div ref={containerRef} class={proseClass()} innerHTML={html()} />
}
