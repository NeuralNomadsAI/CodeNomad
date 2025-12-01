import { createEffect, createSignal, onMount, onCleanup } from "solid-js"
import { renderMarkdown, onLanguagesLoaded, initMarkdown, decodeHtmlEntities } from "../lib/markdown"
import type { TextPart } from "../types/message"

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

    latestRequestedText = text

    // Markdown initialization is now handled globally in App.
    // initMarkdown is idempotent but we avoid per-part calls here.

    if (!highlightEnabled) {
      part.renderCache = undefined

      try {
        const rendered = await renderMarkdown(text, { suppressHighlight: true })

        if (latestRequestedText === text) {
          setHtml(rendered)
          notifyRendered()
        }
      } catch (error) {
        console.error("Failed to render markdown:", error)
        if (latestRequestedText === text) {
          setHtml(text)
          notifyRendered()
        }
      }
      return
    }

    const cache = part.renderCache
    if (cache && cache.text === text && cache.theme === themeKey) {
      setHtml(cache.html)
      notifyRendered()
      return
    }

    try {
      const rendered = await renderMarkdown(text)

      if (latestRequestedText === text) {
        setHtml(rendered)
        part.renderCache = { text, html: rendered, theme: themeKey }
        notifyRendered()
      }
    } catch (error) {
      console.error("Failed to render markdown:", error)
      if (latestRequestedText === text) {
        setHtml(text)
        part.renderCache = { text, html: text, theme: themeKey }
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
          await navigator.clipboard.writeText(decodedCode)
          const copyText = copyButton.querySelector(".copy-text")
          if (copyText) {
            copyText.textContent = "Copied!"
            setTimeout(() => {
              copyText.textContent = "Copy"
            }, 2000)
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
        console.error("Failed to re-render markdown after language load:", error)
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
