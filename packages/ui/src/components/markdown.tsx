import { Show, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js"
import { useGlobalCache } from "../lib/hooks/use-global-cache"
import type { TextPart, RenderCache } from "../types/message"
import { getLogger } from "../lib/logger"
import { copyToClipboard } from "../lib/clipboard"
import { useI18n } from "../lib/i18n"
import {
  MARKDOWN_HIGHLIGHT_CHARACTER_LIMIT,
  MARKDOWN_TEXT_RENDER_CHARACTER_LIMIT,
  STREAMING_INSTANT_RENDER_CHARACTER_LIMIT,
  STREAMING_RENDER_INTERVAL_MS,
  type TextSource,
} from "../lib/render-text-window"
import type { RecordTextRevealTarget } from "../stores/message-v2/record-display-cache"
import { HiddenTextNotice, createTextWindow } from "./hidden-text"
import { isLoopbackHttpUrl } from "./browser-frame-security"
import { openSessionPreview } from "../stores/session-previews"
import { instances } from "../stores/instances"
import { showAlertDialog } from "../stores/alerts"

const log = getLogger("session")

type MarkdownModule = typeof import("../lib/markdown")

interface ResolvedMarkdownSnapshot {
  part: TextPart
  text: string
  themeKey: string
  highlightEnabled: boolean
  escapeRawHtml: boolean
  literalRawHtml: boolean
  defaultCodeBlockWrap: boolean
  partId: string | undefined
  cacheId: string
  version: string
  revealSteps: number
  /** A long window of a streaming reply: rendered at most every interval, unhighlighted. */
  deferred: boolean
}

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
  escapeRawHtml?: boolean
  /** Display user-authored HTML as source text, rather than sanitized elements. */
  literalRawHtml?: boolean
  defaultCodeBlockWrap?: boolean
  /** Characters of `part.text` rendered before the in-place reveal; defaults to the prose bound. */
  renderLimit?: number
  /** Turns the bounded text into Markdown, e.g. a fenced code block for raw tool output. */
  formatText?: (text: string) => string
  /** The whole text as bounded prefixes, instead of `part.text` (e.g. joined tool output). */
  source?: TextSource
  /** Persists the reveal across remounts; without it a reveal lasts for this mount. */
  revealTarget?: RecordTextRevealTarget
  /** The text is still streaming: long windows coalesce re-renders until it completes. */
  streaming?: boolean
  onRendered?: () => void
}

export function Markdown(props: MarkdownProps) {
  const { t } = useI18n()

  // A loopback link click opens the session preview on the instance owning
  // the session; failures surface through the shared alert dialog.
  const openLoopbackPreview = (instanceId: string, sessionId: string, url: string) => {
    const folder = instances().get(instanceId)?.folder ?? ""
    void openSessionPreview(sessionId, url, folder).catch((error) => {
      showAlertDialog(t("sessionPreview.open.title"), {
        title: t("sessionPreview.open.title"),
        detail: error instanceof Error ? error.message : String(error),
        variant: "error",
      })
    })
  }

  const [html, setHtml] = createSignal("")
  // Whether `html` is the Markdown render rather than its plain-text fallback. The
  // reveal line waits for it, so a reveal's anchor never sits on a prefix that re-lays out.
  const [rendered, setRendered] = createSignal(false)
  const bounded = createTextWindow({
    source: () => props.source ?? (typeof props.part.text === "string" ? props.part.text : ""),
    limit: () => props.renderLimit ?? MARKDOWN_TEXT_RENDER_CHARACTER_LIMIT,
    target: () => props.revealTarget,
  })
  let previousSnapshot: ResolvedMarkdownSnapshot | undefined
  let containerRef: HTMLDivElement | undefined
  let latestRenderRequest = 0
  let lastRenderStartedAt = 0
  let deferredRender: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let cleanupLanguageListener: (() => void) | undefined
  const codeBlockWrapOverrides = new Map<string, boolean>()

  const cancelDeferredRender = () => {
    if (deferredRender === undefined) return
    clearTimeout(deferredRender)
    deferredRender = undefined
  }

  onCleanup(() => {
    disposed = true
    cancelDeferredRender()
  })

  const isCurrentRender = (request: number) => !disposed && request === latestRenderRequest

  const notifyRendered = () => {
    Promise.resolve().then(() => {
      if (!disposed) props.onRendered?.()
    })
  }

  const codeBlockWrapKey = (codeBlock: HTMLElement): string | null => {
    const key = codeBlock.getAttribute("data-code-block-key")
    if (!key) {
      return null
    }
    return `${resolved().cacheId}:${key}`
  }

  const applyCodeBlockWrapState = (codeBlock: HTMLElement, enabled: boolean) => {
    codeBlock.setAttribute("data-wrap-lines", enabled ? "true" : "false")

    const button = codeBlock.querySelector<HTMLButtonElement>(".code-block-wrap")
    if (!button) {
      return
    }

    const label = enabled ? t("markdown.codeBlock.wrap.disable") : t("markdown.codeBlock.wrap.enable")
    button.classList.toggle("active", enabled)
    button.setAttribute("aria-pressed", enabled ? "true" : "false")
    button.setAttribute("aria-label", label)
    button.setAttribute("title", label)

    const text = button.querySelector(".wrap-text")
    if (text) {
      text.textContent = label
    }
  }

  const syncCodeBlockWrapStates = () => {
    if (disposed || !containerRef) {
      return
    }

    const codeBlocks = containerRef.querySelectorAll<HTMLElement>(".markdown-code-block")
    for (const codeBlock of codeBlocks) {
      const key = codeBlockWrapKey(codeBlock)
      const defaultEnabled = codeBlock.getAttribute("data-wrap-lines") !== "false"
      const enabled = key ? (codeBlockWrapOverrides.get(key) ?? defaultEnabled) : defaultEnabled
      applyCodeBlockWrapState(codeBlock, enabled)
    }
  }

  const resolved = createMemo(() => {
    const part = props.part
    const window = bounded.window()
    const literalRawHtml = Boolean(props.literalRawHtml)
    const boundedText = props.formatText ? props.formatText(window.text) : window.text
    const text = literalRawHtml ? boundedText : decodeHtmlEntitiesLocally(boundedText)
    const themeKey = Boolean(props.isDark) ? "dark" : "light"
    // Re-parsing a long window for every streamed chunk costs 25-115 ms per chunk at
    // 45 000 characters; short replies keep rendering every chunk, highlighted.
    const deferred = Boolean(props.streaming) && text.length > STREAMING_INSTANT_RENDER_CHARACTER_LIMIT
    const highlightEnabled = !props.disableHighlight && !deferred && text.length <= MARKDOWN_HIGHLIGHT_CHARACTER_LIMIT
    const escapeRawHtml = Boolean(props.escapeRawHtml)
    const defaultCodeBlockWrap = props.defaultCodeBlockWrap ?? true
    const partId = typeof part.id === "string" && part.id.length > 0 ? part.id : undefined
    const cacheId = resolvePartCacheId(part, text)
    // A part version describes its whole text; a bounded window is a distinct render.
    const version = window.hidden > 0
      ? `${resolvePartVersion(part, text)}@${window.text.length}`
      : resolvePartVersion(part, text)
    return {
      revealSteps: bounded.steps(),
      deferred,
      part,
      text,
      themeKey,
      highlightEnabled,
      escapeRawHtml,
      literalRawHtml,
      defaultCodeBlockWrap,
      partId,
      cacheId,
      version,
    }
  })

  const cacheHandle = useGlobalCache({
    instanceId: () => props.instanceId,
    sessionId: () => props.sessionId,
    scope: "markdown",
    cacheId: () => {
      const { cacheId, themeKey, highlightEnabled, escapeRawHtml, literalRawHtml, defaultCodeBlockWrap } = resolved()
      return `${cacheId}:${themeKey}:${highlightEnabled ? 1 : 0}:${literalRawHtml ? "literal" : escapeRawHtml ? 1 : 0}:${defaultCodeBlockWrap ? 1 : 0}`
    },
    version: () => resolved().version,
  })

  const commitCacheEntry = (
    snapshot: ResolvedMarkdownSnapshot,
    renderedHtml: string,
    options?: { cache?: boolean },
  ) => {
    // No `text`: a window is a slice that would retain the whole part beyond its
    // eviction while the cache accounts only for the slice.
    const cacheEntry: RenderCache = {
      html: renderedHtml,
      theme: snapshot.themeKey,
      mode: `${snapshot.version}:${snapshot.literalRawHtml ? "literal" : snapshot.escapeRawHtml ? "escaped" : "raw"}:${snapshot.defaultCodeBlockWrap ? "wrap" : "nowrap"}`,
    }
    setHtml(renderedHtml)
    setRendered(true)
    if (options?.cache ?? true) {
      cacheHandle.set(cacheEntry)
    }
    notifyRendered()
  }

  const renderSnapshot = async (snapshot: ResolvedMarkdownSnapshot, request: number): Promise<void> => {
    const markdown = await loadMarkdownModule()
    // Awaiting even a warm module suspends this invocation. Skip stale work before
    // entering the synchronous parser, including retries with the same key.
    if (!isCurrentRender(request)) return
    markdown.setMarkdownTheme(snapshot.themeKey === "dark")
    const rendered = await markdown.renderMarkdown(snapshot.text, {
      suppressHighlight: !snapshot.highlightEnabled,
      escapeRawHtml: snapshot.escapeRawHtml,
      literalRawHtml: snapshot.literalRawHtml,
      defaultCodeBlockWrap: snapshot.defaultCodeBlockWrap,
    })
    if (!isCurrentRender(request)) return
    const shouldCache = !snapshot.highlightEnabled || !markdown.hasPendingCodeHighlight(snapshot.text)

    if (isCurrentRender(request)) {
      commitCacheEntry(snapshot, rendered, { cache: shouldCache })
    }
  }

  const startRender = (snapshot: ResolvedMarkdownSnapshot, request: number) => {
    lastRenderStartedAt = performance.now()
    void renderSnapshot(snapshot, request).catch((error) => {
      log.error("Failed to render markdown:", error)
      if (isCurrentRender(request)) {
        commitCacheEntry(snapshot, renderFallbackHtml(snapshot.text))
      }
    })
  }

  // At most one render per interval, always of the latest snapshot.
  const scheduleDeferredRender = () => {
    if (deferredRender !== undefined) return
    deferredRender = setTimeout(() => {
      deferredRender = undefined
      if (!disposed) startRender(untrack(resolved), ++latestRenderRequest)
    }, Math.max(0, lastRenderStartedAt + STREAMING_RENDER_INTERVAL_MS - performance.now()))
  }

  createEffect(() => {
    const snapshot = resolved()
    const previous = previousSnapshot
    previousSnapshot = snapshot
    // Cache hits must also invalidate any older render waiting to publish.
    const request = ++latestRenderRequest
    const cacheMode = `${snapshot.version}:${snapshot.literalRawHtml ? "literal" : snapshot.escapeRawHtml ? "escaped" : "raw"}:${snapshot.defaultCodeBlockWrap ? "wrap" : "nowrap"}`

    const cacheMatches = (cache: RenderCache | undefined) => {
      if (!cache) return false
      return cache.theme === snapshot.themeKey && cache.mode === cacheMode
    }

    const localCache = snapshot.part.renderCache
    if (localCache && cacheMatches(localCache)) {
      cancelDeferredRender()
      setHtml(localCache.html)
      setRendered(true)
      notifyRendered()
      return
    }

    const globalCache = cacheHandle.get<RenderCache>()
    if (globalCache && cacheMatches(globalCache)) {
      cancelDeferredRender()
      setHtml(globalCache.html)
      setRendered(true)
      notifyRendered()
      return
    }

    // A reveal, a long streaming window and the render completing such a stream keep
    // the rendered block in place until the next render commits, rather than
    // flashing it as plain text.
    const samePart = previous?.cacheId === snapshot.cacheId && untrack(rendered)
    const revealing = samePart && previous.revealSteps !== snapshot.revealSteps
    if (samePart && snapshot.deferred && !revealing) {
      scheduleDeferredRender()
      return
    }
    cancelDeferredRender()
    if (!(samePart && (revealing || previous.deferred))) {
      setHtml(renderFallbackHtml(snapshot.text))
      setRendered(false)
      notifyRendered()
    }
    startRender(snapshot, request)
  })

  createEffect(() => {
    html()
    Promise.resolve().then(syncCodeBlockWrapStates)
  })

  onMount(() => {
    const handleClick = async (event: Event) => {
      const target = event.target as HTMLElement
      // A plain click on a loopback URL opens the session preview instead of
      // a dead browser tab: browser-accessed frontends cannot reach the
      // backend host's localhost. Modified clicks keep browser defaults.
      const anchor = target.closest("a[href]") as HTMLAnchorElement | null
      if (anchor && props.instanceId && props.sessionId) {
        const href = anchor.getAttribute("href") ?? ""
        const mouseEvent = event as MouseEvent
        const plainClick = !mouseEvent.ctrlKey && !mouseEvent.metaKey && !mouseEvent.shiftKey && !mouseEvent.altKey
        if (plainClick && isLoopbackHttpUrl(href)) {
          event.preventDefault()
          openLoopbackPreview(props.instanceId, props.sessionId, href)
          return
        }
      }
      const wrapButton = target.closest(".code-block-wrap") as HTMLButtonElement
      if (wrapButton) {
        event.preventDefault()
        const codeBlock = wrapButton.closest(".markdown-code-block") as HTMLElement | null
        if (!codeBlock) {
          return
        }

        const key = codeBlockWrapKey(codeBlock)
        const current = codeBlock.getAttribute("data-wrap-lines") !== "false"
        const next = !current
        if (key) {
          codeBlockWrapOverrides.set(key, next)
        }
        applyCodeBlockWrapState(codeBlock, next)
        props.onRendered?.()
        return
      }

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

          const request = ++latestRenderRequest
          void renderSnapshot(snapshot, request).catch((error) => {
            log.error("Failed to re-render markdown after language load:", error)
          })
        })
      })
      .catch((error) => {
        log.error("Failed to load markdown module:", error)
      })

    onCleanup(() => {
      containerRef?.removeEventListener("click", handleClick)
      cleanupLanguageListener?.()
      cleanupLanguageListener = undefined
    })
  })

  return (
    <>
      <div
        ref={containerRef}
        class="markdown-body"
        dir="auto"
        data-view="markdown"
        data-part-id={resolved().partId}
        data-markdown-theme={resolved().themeKey}
        data-markdown-highlight={resolved().highlightEnabled ? "true" : "false"}
        innerHTML={html()}
      />
      <Show when={bounded.window().hidden > 0 && rendered()}>
        <HiddenTextNotice window={bounded.window()} onReveal={bounded.reveal} />
      </Show>
    </>
  )
}
