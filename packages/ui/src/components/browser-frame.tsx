import { ArrowLeft, ArrowRight, ChevronDown, Expand, MessageSquarePlus, Monitor, RefreshCw, RotateCw, Smartphone, Tablet } from "lucide-solid"
import { Show, createEffect, createMemo, createSignal, onCleanup, type Component } from "solid-js"

export interface BrowserFrameElementTarget {
  pagePath: string
  tagName: string
  text?: string
  role?: string
  ariaLabel?: string
  selector?: string
  rect: { x: number; y: number; width: number; height: number }
}

interface BrowserFrameLabels {
  back: string
  refresh: string
  path: string
  go: string
  commentMode?: string
  viewport?: string
  viewportResponsive?: string
  viewportDesktop?: string
  viewportTablet?: string
  viewportTabletLandscape?: string
  viewportMobile?: string
  viewportMobileLandscape?: string
}

type BrowserViewportPreset = "responsive" | "desktop" | "tablet" | "tabletLandscape" | "mobile" | "mobileLandscape"

const VIEWPORT_PRESETS: Record<BrowserViewportPreset, { width: number | null; height: number | null }> = {
  responsive: { width: null, height: null },
  desktop: { width: 1440, height: 900 },
  tablet: { width: 768, height: 1024 },
  tabletLandscape: { width: 1024, height: 768 },
  mobile: { width: 390, height: 844 },
  mobileLandscape: { width: 844, height: 390 },
}

const VIEWPORT_OPTIONS = [
  { id: "responsive" as const, icon: Expand, getLabel: (labels: BrowserFrameLabels) => labels.viewportResponsive },
  { id: "desktop" as const, icon: Monitor, getLabel: (labels: BrowserFrameLabels) => labels.viewportDesktop },
  { id: "tablet" as const, icon: Tablet, getLabel: (labels: BrowserFrameLabels) => labels.viewportTablet },
  { id: "tabletLandscape" as const, icon: RotateCw, getLabel: (labels: BrowserFrameLabels) => labels.viewportTabletLandscape },
  { id: "mobile" as const, icon: Smartphone, getLabel: (labels: BrowserFrameLabels) => labels.viewportMobile },
  { id: "mobileLandscape" as const, icon: RotateCw, getLabel: (labels: BrowserFrameLabels) => labels.viewportMobileLandscape },
]

interface BrowserFrameProps {
  title: string
  initialUrl: string
  proxyBasePath: string
  lockedBaseLabel: string
  labels: BrowserFrameLabels
  commentMode?: boolean
  onToggleCommentMode?: () => void
  onCommentTarget?: (target: BrowserFrameElementTarget) => void
}

function getElementText(element: Element): string | undefined {
  const text = (element.textContent ?? "").replace(/\s+/g, " ").trim()
  return text ? text.slice(0, 120) : undefined
}

function getElementSelector(element: Element): string {
  const parts: string[] = []
  let current: Element | null = element
  while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
    const tag = current.tagName.toLowerCase()
    const id = current.getAttribute("id")
    if (id) {
      parts.unshift(`${tag}#${CSS.escape(id)}`)
      break
    }

    const className = Array.from(current.classList).slice(0, 2).map((item) => `.${CSS.escape(item)}`).join("")
    let part = `${tag}${className}`
    const parentElement: Element | null = current.parentElement
    if (parentElement) {
      const siblings = Array.from(parentElement.children as HTMLCollectionOf<Element>).filter((child) => child.tagName === current?.tagName)
      if (siblings.length > 1) {
        part = `${part}:nth-of-type(${siblings.indexOf(current) + 1})`
      }
    }
    parts.unshift(part)
    current = parentElement
  }
  return parts.join(" > ")
}

export const BrowserFrame: Component<BrowserFrameProps> = (props) => {
  const [frameSrc, setFrameSrc] = createSignal(props.initialUrl)
  const [pathInput, setPathInput] = createSignal("/")
  const [viewportPreset, setViewportPreset] = createSignal<BrowserViewportPreset>("responsive")
  const [viewportMenuOpen, setViewportMenuOpen] = createSignal(false)
  const [highlight, setHighlight] = createSignal<{ x: number; y: number; width: number; height: number } | null>(null)
  let iframeRef: HTMLIFrameElement | undefined
  let frameWrapRef: HTMLDivElement | undefined
  let cleanupFrameListeners: (() => void) | null = null

  const canComment = createMemo(() => Boolean(props.onToggleCommentMode && props.onCommentTarget))
  const viewport = createMemo(() => VIEWPORT_PRESETS[viewportPreset()])
  const isResponsiveViewport = createMemo(() => viewportPreset() === "responsive")
  const selectedViewportOption = createMemo(() => VIEWPORT_OPTIONS.find((option) => option.id === viewportPreset()) ?? VIEWPORT_OPTIONS[0])

  const getEditablePathFromUrl = (url: string): string => {
    try {
      const parsed = new URL(url, window.location.origin)
      const basePath = props.proxyBasePath
      let pathname = parsed.pathname

      if (basePath && pathname.startsWith(basePath)) {
        pathname = pathname.slice(basePath.length) || "/"
      }

      if (!pathname.startsWith("/")) {
        pathname = `/${pathname}`
      }

      return `${pathname}${parsed.search}${parsed.hash}`
    } catch {
      return "/"
    }
  }

  const buildNormalizedTargetUrl = (rawInput: string): string => {
    const trimmed = rawInput.trim()
    const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`
    const parsed = new URL(withLeadingSlash || "/", window.location.origin)

    const safeSegments: string[] = []
    for (const segment of parsed.pathname.split("/")) {
      if (!segment || segment === ".") continue
      if (segment === "..") {
        if (safeSegments.length > 0) safeSegments.pop()
        continue
      }
      safeSegments.push(segment)
    }

    const normalizedPath = `/${safeSegments.join("/")}` || "/"
    return `${props.proxyBasePath}${normalizedPath}${parsed.search}${parsed.hash}`
  }

  const buildElementTarget = (element: Element): BrowserFrameElementTarget => {
    const rect = element.getBoundingClientRect()
    const pagePath = getEditablePathFromUrl(iframeRef?.contentWindow?.location.href ?? frameSrc())
    return {
      pagePath,
      tagName: element.tagName.toLowerCase(),
      text: getElementText(element),
      role: element.getAttribute("role") ?? undefined,
      ariaLabel: element.getAttribute("aria-label") ?? undefined,
      selector: getElementSelector(element),
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    }
  }

  const attachCommentListeners = () => {
    cleanupFrameListeners?.()
    cleanupFrameListeners = null
    setHighlight(null)

    if (!props.commentMode || !iframeRef?.contentDocument || !iframeRef.contentWindow || !frameWrapRef) return
    const doc = iframeRef.contentDocument
    const frameWindow = iframeRef.contentWindow

    const handleMove = (event: MouseEvent) => {
      const target = event.target
      if (!target || !(target instanceof (frameWindow as any).Element)) return
      const element = target as Element
      const rect = element.getBoundingClientRect()
      const frameRect = iframeRef?.getBoundingClientRect()
      const wrapRect = frameWrapRef?.getBoundingClientRect()
      if (!frameRect || !wrapRect) return
      setHighlight({
        x: frameRect.left - wrapRect.left + rect.x,
        y: frameRect.top - wrapRect.top + rect.y,
        width: rect.width,
        height: rect.height,
      })
    }

    const handleLeave = () => setHighlight(null)

    const handleClick = (event: MouseEvent) => {
      const target = event.target
      if (!target || !(target instanceof (frameWindow as any).Element)) return
      event.preventDefault()
      event.stopPropagation()
      props.onCommentTarget?.(buildElementTarget(target as Element))
    }

    doc.addEventListener("mousemove", handleMove, true)
    doc.addEventListener("mouseleave", handleLeave, true)
    doc.addEventListener("click", handleClick, true)
    cleanupFrameListeners = () => {
      doc.removeEventListener("mousemove", handleMove, true)
      doc.removeEventListener("mouseleave", handleLeave, true)
      doc.removeEventListener("click", handleClick, true)
    }
  }

  const syncPathInputFromFrame = () => {
    try {
      const currentHref = iframeRef?.contentWindow?.location.href
      if (currentHref) setPathInput(getEditablePathFromUrl(currentHref))
    } catch {
      setPathInput(getEditablePathFromUrl(frameSrc()))
    }
    attachCommentListeners()
  }

  createEffect(() => {
    setFrameSrc(props.initialUrl)
    setPathInput(getEditablePathFromUrl(props.initialUrl))
  })

  createEffect(() => {
    props.commentMode
    attachCommentListeners()
  })

  onCleanup(() => cleanupFrameListeners?.())

  const handleBack = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    try {
      iframeRef?.contentWindow?.history.go(-1)
    } catch {
      // Ignore navigation errors from pages that do not expose history access.
    }
  }

  const handleRefresh = () => {
    try {
      iframeRef?.contentWindow?.location.reload()
      return
    } catch {
      // Fall back to resetting the iframe source if the frame cannot be reloaded directly.
    }
    setFrameSrc("about:blank")
    requestAnimationFrame(() => setFrameSrc(props.initialUrl))
  }

  const handleGo = (event?: Event) => {
    event?.preventDefault()
    const nextUrl = buildNormalizedTargetUrl(pathInput())
    setFrameSrc(nextUrl)
    setPathInput(getEditablePathFromUrl(nextUrl))
  }

  return (
    <div class="flex h-full min-h-0 w-full flex-col bg-surface">
      <div class="flex shrink-0 items-center gap-2 px-3 py-2" style={{ "border-bottom": "1px solid var(--border-base)" }}>
        <button type="button" class="new-tab-button" onClick={handleBack} title={props.labels.back} aria-label={props.labels.back}>
          <ArrowLeft class="h-4 w-4" />
        </button>
        <button type="button" class="new-tab-button" onClick={handleRefresh} title={props.labels.refresh} aria-label={props.labels.refresh}>
          <RefreshCw class="h-4 w-4" />
        </button>
        <div class="shrink-0 rounded-md px-3 py-1.5 text-sm" style={{ background: "var(--surface-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-base)" }}>
          {props.lockedBaseLabel}
        </div>
        <form class="flex min-w-0 flex-1 items-center gap-2" onSubmit={(event) => handleGo(event)}>
          <input
            type="text"
            class="min-w-0 flex-1 rounded-md px-3 py-1.5 text-sm outline-none"
            style={{ background: "var(--surface-secondary)", color: "var(--text-primary)", border: "1px solid var(--border-base)" }}
            value={pathInput()}
            onInput={(event) => setPathInput(event.currentTarget.value)}
            spellcheck={false}
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            aria-label={props.labels.path}
          />
          <button type="submit" class="new-tab-button" title={props.labels.go} aria-label={props.labels.go}>
            <ArrowRight class="h-4 w-4" />
          </button>
        </form>
        <div class="relative shrink-0">
          <button
            type="button"
            class="selector-button selector-button-secondary px-2 py-1.5 text-sm"
            aria-label={props.labels.viewport}
            title={props.labels.viewport}
            aria-haspopup="menu"
            aria-expanded={viewportMenuOpen() ? "true" : "false"}
            onClick={() => setViewportMenuOpen((open) => !open)}
          >
            {(() => {
              const Icon = selectedViewportOption().icon
              return <Icon class="h-4 w-4" />
            })()}
            <ChevronDown class="h-3.5 w-3.5" />
          </button>
          <Show when={viewportMenuOpen()}>
            <div
              class="absolute right-0 top-full z-20 mt-1 min-w-[13rem] overflow-hidden rounded-md border border-base shadow-xl"
              style={{ background: "var(--surface-base)", color: "var(--text-primary)" }}
              role="menu"
            >
              {VIEWPORT_OPTIONS.map((option) => {
                const Icon = option.icon
                return (
                  <button
                    type="button"
                    class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-secondary"
                    style={viewportPreset() === option.id ? { color: "var(--accent-primary)" } : undefined}
                    role="menuitemradio"
                    aria-checked={viewportPreset() === option.id ? "true" : "false"}
                    aria-label={option.getLabel(props.labels)}
                    title={option.getLabel(props.labels)}
                    onClick={() => {
                      setViewportPreset(option.id)
                      setViewportMenuOpen(false)
                    }}
                  >
                    <Icon class="h-4 w-4" />
                    <span>{option.getLabel(props.labels)}</span>
                  </button>
                )
              })}
            </div>
          </Show>
        </div>
        <Show when={canComment()}>
          <button
            type="button"
            class="new-tab-button"
            style={props.commentMode ? { color: "var(--accent-primary)" } : undefined}
            title={props.labels.commentMode}
            aria-label={props.labels.commentMode}
            aria-pressed={props.commentMode ? "true" : "false"}
            onClick={props.onToggleCommentMode}
          >
            <MessageSquarePlus class="h-4 w-4" />
          </button>
        </Show>
      </div>
      <div ref={frameWrapRef} class="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <div
          class={isResponsiveViewport()
            ? "absolute inset-0 overflow-hidden bg-surface"
            : "absolute inset-0 overflow-auto bg-surface-secondary p-4"}
        >
          <iframe
            ref={iframeRef}
            src={frameSrc()}
            title={props.title}
            class={isResponsiveViewport() ? "block border-0 bg-surface" : "block border-0 bg-surface shadow-xl"}
            style={{
              width: viewport().width ? `${viewport().width}px` : "100%",
              height: viewport().height ? `${viewport().height}px` : "100%",
              margin: viewport().width ? "0 auto" : "0",
            }}
            referrerPolicy="same-origin"
            onLoad={syncPathInputFromFrame}
          />
        </div>
        <Show when={props.commentMode && highlight()}>
          {(rect) => (
            <div
              class="pointer-events-none absolute rounded-md"
              style={{
                left: `${rect().x}px`,
                top: `${rect().y}px`,
                width: `${rect().width}px`,
                height: `${rect().height}px`,
                border: "2px solid var(--accent-primary)",
                "box-shadow": "0 0 0 9999px rgba(0, 0, 0, 0.08)",
              }}
            />
          )}
        </Show>
      </div>
    </div>
  )
}
