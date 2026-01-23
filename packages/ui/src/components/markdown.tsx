import { createEffect, createSignal, onMount, onCleanup } from "solid-js"
import { renderMarkdown, onLanguagesLoaded, initMarkdown, decodeHtmlEntities } from "../lib/markdown"
import type { TextPart, RenderCache } from "../types/message"
import { getLogger } from "../lib/logger"
import { copyToClipboard } from "../lib/clipboard"
const log = getLogger("session")

const markdownRenderCache = new Map<string, RenderCache>()

function makeMarkdownCacheKey(partId: string, themeKey: string, highlightEnabled: boolean, versionKey: string) {
  const versionSegment = versionKey.length > 0 ? versionKey : "noversion"
  return `${partId}:${themeKey}:${highlightEnabled ? 1 : 0}:${versionSegment}`
}

interface MarkdownProps {
  part: TextPart
  isDark?: boolean
  size?: "base" | "sm" | "tight"
  disableHighlight?: boolean
  onRendered?: () => void
}

export function Markdown(props: MarkdownProps) {
  const [html, setHtml] = createSignal("")
  let containerRef: HTMLDivElement | undefined
  let latestRequestedText = ""

  const notifyRendered = () => {
    Promise.resolve().then(() => props.onRendered?.())
  }

  createEffect(async () => {
    const part = props.part
    const rawText = typeof part.text === "string" ? part.text : ""
    const text = decodeHtmlEntities(rawText)
    const dark = Boolean(props.isDark)
    const themeKey = dark ? "dark" : "light"
    const highlightEnabled = !props.disableHighlight
    const partId = typeof part.id === "string" && part.id.length > 0 ? part.id : "__anonymous__"
    const versionKey = typeof part.version === "number" ? String(part.version) : ""
    const cacheKey = makeMarkdownCacheKey(partId, themeKey, highlightEnabled, versionKey)

    latestRequestedText = text

    const localCache = part.renderCache
    const cacheMatches = (cache: RenderCache | undefined) => {
      if (!cache) return false
      if (versionKey.length > 0) {
        return cache.mode === versionKey && cache.theme === themeKey
      }
      return cache.text === text && cache.theme === themeKey
    }

    if (localCache && cacheMatches(localCache)) {
      setHtml(localCache.html)
      notifyRendered()
      return
    }

    const globalCache = markdownRenderCache.get(cacheKey)
    if (globalCache && cacheMatches(globalCache)) {
      setHtml(globalCache.html)
      part.renderCache = globalCache
      notifyRendered()
      return
    }

    if (!highlightEnabled) {
      part.renderCache = undefined

      try {
        const rendered = await renderMarkdown(text, { suppressHighlight: true })

        if (latestRequestedText === text) {
          const cacheEntry: RenderCache = { text, html: rendered, theme: themeKey, mode: versionKey || undefined }
          setHtml(rendered)
          part.renderCache = cacheEntry
          markdownRenderCache.set(cacheKey, cacheEntry)
          notifyRendered()
        }
      } catch (error) {
        log.error("Failed to render markdown:", error)
        if (latestRequestedText === text) {
          const cacheEntry: RenderCache = { text, html: text, theme: themeKey, mode: versionKey || undefined }
          setHtml(text)
          part.renderCache = cacheEntry
          markdownRenderCache.set(cacheKey, cacheEntry)
          notifyRendered()
        }
      }
      return
    }

    try {
      const rendered = await renderMarkdown(text)

      if (latestRequestedText === text) {
        const cacheEntry: RenderCache = { text, html: rendered, theme: themeKey, mode: versionKey || undefined }
        setHtml(rendered)
        part.renderCache = cacheEntry
        markdownRenderCache.set(cacheKey, cacheEntry)
        notifyRendered()
      }
    } catch (error) {
      log.error("Failed to render markdown:", error)
      if (latestRequestedText === text) {
        const cacheEntry: RenderCache = { text, html: text, theme: themeKey, mode: versionKey || undefined }
        setHtml(text)
        part.renderCache = cacheEntry
        markdownRenderCache.set(cacheKey, cacheEntry)
        notifyRendered()
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
              copyText.textContent = "Copied!"
              setTimeout(() => {
                copyText.textContent = "Copy"
              }, 2000)
            } else {
              copyText.textContent = "Failed"
              setTimeout(() => {
                copyText.textContent = "Copy"
              }, 2000)
            }
          }
        }
      }
    }

    containerRef?.addEventListener("click", handleClick)

    // Register listener for language loading completion
    const cleanupLanguageListener = onLanguagesLoaded(async () => {
      if (props.disableHighlight) {
        return
      }

      const part = props.part
      const rawText = typeof part.text === "string" ? part.text : ""
      const text = decodeHtmlEntities(rawText)

      if (latestRequestedText !== text) {
        return
      }

      try {
        const rendered = await renderMarkdown(text)
        if (latestRequestedText === text) {
          setHtml(rendered)
          const themeKey = Boolean(props.isDark) ? "dark" : "light"
          part.renderCache = { text, html: rendered, theme: themeKey }
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
