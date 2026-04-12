import { Show, createEffect, createSignal, onCleanup, type Component } from "solid-js"
import type { FilePreviewerProps } from "./types"
import { useTheme } from "../../lib/theme"
import { useI18n } from "../../lib/i18n"
import { MonacoFileViewer } from "./monaco-file-viewer"

const renderCache = new Map<string, string>()

const MarkdownViewer: Component<FilePreviewerProps> = (props) => {
  const { isDark } = useTheme()
  const { t } = useI18n()
  const [localViewMode, setLocalViewMode] = createSignal<"rendered" | "code">("rendered")
  const viewMode = () => props.initialViewMode ?? localViewMode()
  const [html, setHtml] = createSignal<string>("")
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  const [cacheVersion, setCacheVersion] = createSignal(0)
  let container: HTMLDivElement | undefined

  const cacheKey = () => `${props.path}::${props.content.length}::${simpleHash(props.content)}`

  const renderMarkdown = async (content: string) => {
    setLoading(true)
    setError(null)
    try {
      const mod = await import("../../lib/markdown")
      if (mod.initMarkdown) mod.initMarkdown(isDark())
      if (mod.setMarkdownTheme) mod.setMarkdownTheme(isDark())
      const rendered = await mod.renderMarkdown(content, { escapeRawHtml: true })
      const processed = await inlineMarkdownImages(rendered)
      setHtml(processed)
      renderCache.set(cacheKey(), processed)
    } catch (e) {
      setError(e instanceof Error ? e.message : t("fileViewer.markdown.renderFailed"))
    } finally {
      setLoading(false)
    }
  }

  const inlineMarkdownImages = async (renderedHtml: string): Promise<string> => {
    if (!props.onGetBlobUrl) return renderedHtml
    const imgRegex = /<img\s+[^>]*src=["']([^"']+)["'][^>]*>/gi
    const matches = [...renderedHtml.matchAll(imgRegex)]
    if (matches.length === 0) return renderedHtml
    let result = renderedHtml
    for (const match of matches) {
      const fullTag = match[0]
      const src = match[1]
      if (src.startsWith("http://") || src.startsWith("https://") || src.startsWith("data:") || src.startsWith("blob:")) continue
      const blobUrl = await props.onGetBlobUrl!(src)
      if (blobUrl) {
        result = result.replace(fullTag, fullTag.replace(src, blobUrl))
      }
    }
    return result
  }

  createEffect(() => {
    if (viewMode() !== "rendered" || !props.content) return
    cacheVersion()
    const key = cacheKey()
    const cached = renderCache.get(key)
    if (cached) {
      setHtml(cached)
      setLoading(false)
      setError(null)
      return
    }
    void renderMarkdown(props.content)
  })

  createEffect(() => {
    const modPromise = import("../../lib/markdown")
    const unsub = modPromise.then((mod) => {
      if (mod.onLanguagesLoaded) {
        return mod.onLanguagesLoaded(() => {
          renderCache.clear()
          setCacheVersion((v) => v + 1)
        })
      }
      return () => {}
    })
    onCleanup(() => {
      void unsub.then((fn) => fn?.())
    })
  })

  const handleContentClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement
    const link = target.closest("a")
    if (!link || !props.onNavigate) return
    const href = link.getAttribute("href")
    if (!href || href.startsWith("http://") || href.startsWith("https://") || href.startsWith("mailto:") || href.startsWith("#")) return
    const isInternalMarkdown = href.endsWith(".md") || href.includes(".md#")
    if (!isInternalMarkdown) return
    e.preventDefault()
    const resolved = resolveRelativePath(props.path, href)
    if (resolved) props.onNavigate(resolved)
  }

  const resolveRelativePath = (basePath: string, relativePath: string): string | null => {
    const parts = basePath.split("/").filter(Boolean)
    parts.pop()
    const relParts = relativePath.split("/").filter(Boolean)
    for (const part of relParts) {
      if (part === "..") {
        if (parts.length === 0) return null
        parts.pop()
      } else if (part !== ".") {
        parts.push(part)
      }
    }
    return parts.length > 0 ? parts.join("/") : null
  }

  const simpleHash = (str: string): string => {
    let h = 0
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i)
      h = ((h << 5) - h + c) | 0
    }
    return h.toString(36)
  }

  return (
    <div class="markdown-viewer flex flex-col h-full">
      <div class="markdown-viewer-content flex-1 overflow-auto min-h-0">
        <Show when={viewMode() === "rendered"}>
          <Show when={loading()}>
            <div class="flex items-center justify-center h-full">
              <span class="text-xs text-secondary">{t("instanceInfo.loading")}</span>
            </div>
          </Show>
          <Show when={error()}>
            {(err) => <div class="flex items-center justify-center h-full text-error">{err()}</div>}
          </Show>
          <Show when={!loading() && !error() && html()}>
            <div class="markdown-body p-4" ref={container} innerHTML={html()} onClick={handleContentClick} />
          </Show>
        </Show>
        <Show when={viewMode() === "code"}>
          <MonacoFileViewer
            scopeKey={props.scopeKey}
            path={props.path}
            content={props.content}
            onSave={props.onSave}
            onContentChange={props.onContentChange}
          />
        </Show>
      </div>
    </div>
  )
}

export default MarkdownViewer
