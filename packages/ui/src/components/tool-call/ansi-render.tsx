import { createEffect, onCleanup, type Accessor, type JSXElement } from "solid-js"
import type { RenderCache } from "../../types/message"
import { ansiToHtml, createAnsiStreamRenderer, hasAnsi } from "../../lib/ansi"
import { escapeHtml } from "../../lib/text-render-utils"
import type { AnsiRenderOptions, ToolScrollHelpers } from "./types"

type AnsiRenderCache = RenderCache & { hasAnsi: boolean }

type CacheHandle = {
  get<T>(): T | undefined
  set(value: unknown): void
}

function StreamingAnsiContent(props: {
  html: string
  htmlChunk?: string
  updateMode: "replace" | "append" | "noop"
}) {
  let preRef: HTMLPreElement | undefined

  createEffect(() => {
    const mode = props.updateMode
    const element = preRef
    if (!element) return
    if (mode === "noop") {
      return
    }
    if (mode === "append") {
      if (element.innerHTML.length === 0) {
        element.innerHTML = props.html
        return
      }
      const chunk = props.htmlChunk ?? ""
      if (chunk.length > 0) {
        element.insertAdjacentHTML("beforeend", chunk)
      }
      return
    }
    if (element.innerHTML !== props.html) {
      element.innerHTML = props.html
    }
  })

  onCleanup(() => {
    preRef = undefined
  })

  return <pre ref={preRef} class="tool-call-content tool-call-ansi" dir="auto" />
}

export function createAnsiContentRenderer(params: {
  ansiRunningCache: CacheHandle
  ansiFinalCache: CacheHandle
  scrollHelpers: ToolScrollHelpers
  partVersion?: Accessor<number | undefined>
}) {
  const runningAnsiRenderer = createAnsiStreamRenderer()
  let runningAnsiSource = ""

  const registerTracked = (element: HTMLDivElement | null) => {
    params.scrollHelpers.registerContainer(element)
  }

  const registerUntracked = (element: HTMLDivElement | null) => {
    params.scrollHelpers.registerContainer(element, { disableTracking: true })
  }

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
    const disableScrollTracking = !isRunningVariant
    const registerRef = disableScrollTracking ? registerUntracked : registerTracked
    let updateMode: "replace" | "append" | "noop" = "replace"
    let htmlChunk = ""

    let nextCache: AnsiRenderCache

    if (isRunningVariant) {
      const content = options.content
      const resetStreaming = !cached || !cached.text || !content.startsWith(cached.text) || cached.text !== runningAnsiSource

      if (resetStreaming) {
        updateMode = "replace"
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
          updateMode = "noop"
          nextCache = { ...cached, mode }
        } else if (!cached.hasAnsi && hasAnsi(delta)) {
          updateMode = "replace"
          runningAnsiRenderer.reset()
          const html = runningAnsiRenderer.render(content)
          nextCache = { text: content, html, mode, hasAnsi: true }
        } else if (cached.hasAnsi) {
          const appendedHtml = runningAnsiRenderer.render(delta)
          updateMode = "append"
          htmlChunk = appendedHtml
          nextCache = { text: content, html: `${cached.html}${appendedHtml}`, mode, hasAnsi: true }
        } else {
          updateMode = "append"
          htmlChunk = escapeHtml(delta)
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
      <div class={messageClass} ref={registerRef} onScroll={disableScrollTracking ? undefined : params.scrollHelpers.handleScroll}>
        <StreamingAnsiContent html={nextCache.html} htmlChunk={htmlChunk} updateMode={updateMode} />
        {params.scrollHelpers.renderSentinel({ disableTracking: disableScrollTracking })}
      </div>
    )
  }

  return { renderAnsiContent }
}
