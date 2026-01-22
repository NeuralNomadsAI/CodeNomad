import type { Accessor, JSXElement } from "solid-js"
import type { RenderCache } from "../../types/message"
import { ansiToHtml, createAnsiStreamRenderer, hasAnsi } from "../../lib/ansi"
import { escapeHtml } from "../../lib/markdown"
import type { AnsiRenderOptions, ToolScrollHelpers } from "./types"

type AnsiRenderCache = RenderCache & { hasAnsi: boolean }

type CacheHandle = {
  get<T>(): T | undefined
  set(value: unknown): void
}

export function createAnsiContentRenderer(params: {
  ansiRunningCache: CacheHandle
  ansiFinalCache: CacheHandle
  scrollHelpers: ToolScrollHelpers
  partVersion?: Accessor<number | undefined>
}) {
  const runningAnsiRenderer = createAnsiStreamRenderer()
  let runningAnsiSource = ""

  const getMode = () => {
    const version = params.partVersion?.()
    return typeof version === "number" ? String(version) : undefined
  }

  function renderAnsiContent(options: AnsiRenderOptions): JSXElement | null {
    if (!options.content) {
      return null
    }

    const size = options.size || "default"
    const messageClass = `message-text tool-call-markdown${size === "large" ? " tool-call-markdown-large" : ""}`
    const cacheHandle = options.variant === "running" ? params.ansiRunningCache : params.ansiFinalCache
    const cached = cacheHandle.get<AnsiRenderCache>()
    const mode = getMode()
    const isRunningVariant = options.variant === "running"

    let nextCache: AnsiRenderCache

    if (isRunningVariant) {
      const content = options.content
      const resetStreaming = !cached || !cached.text || !content.startsWith(cached.text) || cached.text !== runningAnsiSource

      if (resetStreaming) {
        const detectedAnsi = hasAnsi(content)
        if (detectedAnsi) {
          runningAnsiRenderer.reset()
          const html = runningAnsiRenderer.render(content)
          nextCache = { text: content, html, mode, hasAnsi: true }
        } else {
          runningAnsiRenderer.reset()
          nextCache = { text: content, html: escapeHtml(content), mode, hasAnsi: false }
        }
      } else {
        const delta = content.slice(cached.text.length)
        if (delta.length === 0) {
          nextCache = { ...cached, mode }
        } else if (!cached.hasAnsi && hasAnsi(delta)) {
          runningAnsiRenderer.reset()
          const html = runningAnsiRenderer.render(content)
          nextCache = { text: content, html, mode, hasAnsi: true }
        } else if (cached.hasAnsi) {
          const htmlChunk = runningAnsiRenderer.render(delta)
          nextCache = { text: content, html: `${cached.html}${htmlChunk}`, mode, hasAnsi: true }
        } else {
          nextCache = { text: content, html: `${cached.html}${escapeHtml(delta)}`, mode, hasAnsi: false }
        }
      }

      runningAnsiSource = nextCache.text
      cacheHandle.set(nextCache)
    } else {
      if (cached && cached.text === options.content) {
        nextCache = { ...cached, mode }
      } else {
        const detectedAnsi = hasAnsi(options.content)
        const html = detectedAnsi ? ansiToHtml(options.content) : escapeHtml(options.content)
        nextCache = { text: options.content, html, mode, hasAnsi: detectedAnsi }
        cacheHandle.set(nextCache)
      }
    }

    if (options.requireAnsi && !nextCache.hasAnsi) {
      return null
    }

    return (
      <div class={messageClass} ref={(element) => params.scrollHelpers.registerContainer(element)} onScroll={params.scrollHelpers.handleScroll}>
        <pre class="tool-call-content tool-call-ansi" innerHTML={nextCache.html} />
        {params.scrollHelpers.renderSentinel()}
      </div>
    )
  }

  return { renderAnsiContent }
}
