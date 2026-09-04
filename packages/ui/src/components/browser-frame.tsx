import { ArrowLeft, ArrowRight, ChevronDown, Expand, MessageSquarePlus, Monitor, RefreshCw, RotateCw, Smartphone, Tablet } from "lucide-solid"
import { Show, createEffect, createMemo, createSignal, onCleanup, untrack, type Component } from "solid-js"
import { runtimeEnv } from "../lib/runtime-env"
import {
  controlTauriBrowserTarget,
  nativeBrowserHost,
  onTauriBrowserNavigation,
  physicalBrowserBounds,
  registerTauriBrowserTarget,
  unregisterTauriBrowserTarget,
  updateTauriBrowserTarget,
} from "../lib/native/browser"
import { getBrowserFramePolicy, normalizeBrowserPreviewUrl } from "./browser-frame-security"

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
  invalidUrl?: string
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
  sessionId?: string
  title: string
  initialUrl: string
  initialAddress?: string
  proxyBasePath: string
  lockedBaseLabel?: string
  labels: BrowserFrameLabels
  addressMode?: "path" | "url"
  onNavigate?: (address: string) => Promise<string>
  onNavigationError?: (error: unknown) => void
  onFrameLocation?: (path: string) => string | void
  commentBridge?: boolean
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
  const [pathInput, setPathInput] = createSignal(props.initialAddress ?? "/")
  const [viewportPreset, setViewportPreset] = createSignal<BrowserViewportPreset>("responsive")
  const [viewportMenuOpen, setViewportMenuOpen] = createSignal(false)
  const [navigating, setNavigating] = createSignal(false)
  const [highlight, setHighlight] = createSignal<{ x: number; y: number; width: number; height: number } | null>(null)
  const browserHost = nativeBrowserHost(runtimeEnv)
  const nativeBrowserAvailable = Boolean(browserHost) && props.addressMode === "url"
  const [nativeMode, setNativeMode] = createSignal(nativeBrowserAvailable)
  const [nativeTarget, setNativeTarget] = createSignal(props.initialAddress ?? "")
  let iframeRef: HTMLIFrameElement | undefined
  let webviewRef: ElectronBrowserWebviewElement | undefined
  let frameWrapRef: HTMLDivElement | undefined
  let cleanupFrameListeners: (() => void) | null = null
  let cleanupWebviewListeners: (() => void) | null = null
  let cleanupTauriTarget: (() => void) | null = null
  let tauriRegistered = false
  let browserRegistrationId = crypto.randomUUID()

  const framePolicy = getBrowserFramePolicy(runtimeEnv)
  const canComment = createMemo(() => !nativeMode() && (framePolicy.canInspectDom || props.commentBridge) && Boolean(props.onToggleCommentMode && props.onCommentTarget))
  const viewport = createMemo(() => VIEWPORT_PRESETS[viewportPreset()])
  const isResponsiveViewport = createMemo(() => viewportPreset() === "responsive")
  const selectedViewportOption = createMemo(() => VIEWPORT_OPTIONS.find((option) => option.id === viewportPreset()) ?? VIEWPORT_OPTIONS[0])

  const getEditablePathFromUrl = (url: string): string => {
    try {
      const parsed = new URL(url, window.location.origin)
      const basePath = props.proxyBasePath
      if (props.addressMode === "url") {
        if (props.initialAddress && parsed.href === new URL(props.initialUrl, window.location.origin).href) {
          return props.initialAddress
        }
        if (props.initialAddress && basePath && parsed.pathname.startsWith(basePath)) {
          const target = new URL(props.initialAddress)
          target.pathname = parsed.pathname.slice(basePath.length) || "/"
          target.search = parsed.search
          target.hash = parsed.hash
          return target.href
        }
        return parsed.href
      }
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

    if (!iframeRef?.contentWindow || !frameWrapRef) return
    const frameWindow = iframeRef.contentWindow
    if (props.commentBridge && !framePolicy.canInspectDom) {
      frameWindow.postMessage({ type: "codenomad-preview-comment-mode", enabled: Boolean(props.commentMode) }, "*")
      const handleMessage = (event: MessageEvent) => {
        if (event.source !== frameWindow || event.origin !== "null") return
        if (event.data?.type === "codenomad-preview-location") {
          const path = event.data.path
          if (typeof path !== "string" || path.length > 4_096 || !path.startsWith("/")) return
          const address = props.onFrameLocation?.(path)
          if (address) setPathInput(address)
          return
        }
        if (event.data?.type !== "codenomad-preview-comment" || !props.commentMode) return
        if (event.data.kind === "leave") return setHighlight(null)
        const target = event.data.target as BrowserFrameElementTarget | undefined
        const rect = target?.rect
        if (!target || !rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return
        const frameRect = iframeRef?.getBoundingClientRect()
        const wrapRect = frameWrapRef?.getBoundingClientRect()
        if (!frameRect || !wrapRect) return
        setHighlight({
          x: frameRect.left - wrapRect.left + rect.x,
          y: frameRect.top - wrapRect.top + rect.y,
          width: rect.width,
          height: rect.height,
        })
        if (event.data.kind === "select") props.onCommentTarget?.(target)
      }
      window.addEventListener("message", handleMessage)
      cleanupFrameListeners = () => window.removeEventListener("message", handleMessage)
      return
    }
    if (!props.commentMode) return
    if (!framePolicy.canInspectDom || !iframeRef.contentDocument) return
    const doc = iframeRef.contentDocument

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

  const reportNativeError = (error: unknown) => props.onNavigationError?.(error)

  const bindWebview = (webview: ElectronBrowserWebviewElement) => {
    cleanupWebviewListeners?.()
    webviewRef = webview
    let active = true
    let registered = false
    let registeredSessionId = ""
    let registering = false
    let registrationFailures = 0
    let registrationErrorReported = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    const syncLocation = (event: Event) => {
      const url = (event as Event & { url?: string }).url ?? webview.getURL()
      if (!url) return
      setPathInput(url)
      props.onFrameLocation?.(url)
    }
    const reportLoadError = (event: Event) => {
      const failure = event as Event & { errorCode?: number; errorDescription?: string }
      if (failure.errorCode === -3) return
      reportNativeError(new Error(failure.errorDescription || `Browser failed to load (${failure.errorCode ?? "unknown"})`))
    }
    const retryRegistration = (error: unknown) => {
      registering = false
      registrationFailures += 1
      if (registrationFailures >= 5 && !registrationErrorReported) {
        registrationErrorReported = true
        reportNativeError(error)
      }
      if (active) retryTimer = setTimeout(syncRegistration, 100)
    }
    const syncRegistration = () => {
      const rect = webview.getBoundingClientRect()
      const visible = active && rect.width > 0 && rect.height > 0
      const sessionId = props.sessionId
      if (!sessionId || registering) return
      if (registered && registeredSessionId !== sessionId) {
        const previousId = browserRegistrationId
        browserRegistrationId = crypto.randomUUID()
        registering = true
        registered = false
        registeredSessionId = ""
        void window.electronAPI?.unregisterBrowserTarget?.(previousId).catch(reportNativeError).finally(() => {
          registering = false
          if (active) syncRegistration()
        })
        return
      }
      if (visible === registered) return
      if (!visible) {
        if (retryTimer) clearTimeout(retryTimer)
        retryTimer = undefined
        if (registered) {
          registering = true
          void window.electronAPI?.unregisterBrowserTarget?.(browserRegistrationId).catch(reportNativeError).finally(() => {
            registering = false
            if (active) syncRegistration()
          })
        }
        registered = false
        registeredSessionId = ""
        return
      }
      const register = window.electronAPI?.registerBrowserTarget
      if (!register) return
      registering = true
      try {
        void register({
          sessionId,
          registrationId: browserRegistrationId,
          guestWebContentsId: webview.getWebContentsId(),
        }).then(() => {
          registering = false
          registered = true
          registeredSessionId = sessionId
          registrationFailures = 0
          registrationErrorReported = false
          syncRegistration()
        }).catch(retryRegistration)
      } catch (error) {
        retryRegistration(error)
      }
    }
    const resizeObserver = new ResizeObserver(syncRegistration)
    resizeObserver.observe(webview)
    createEffect(syncRegistration)
    webview.addEventListener("did-navigate", syncLocation)
    webview.addEventListener("did-navigate-in-page", syncLocation)
    webview.addEventListener("did-fail-load", reportLoadError)
    webview.addEventListener("dom-ready", syncRegistration)
    syncRegistration()
    cleanupWebviewListeners = () => {
      active = false
      if (retryTimer) clearTimeout(retryTimer)
      webview.removeEventListener("did-navigate", syncLocation)
      webview.removeEventListener("did-navigate-in-page", syncLocation)
      webview.removeEventListener("did-fail-load", reportLoadError)
      webview.removeEventListener("dom-ready", syncRegistration)
      resizeObserver.disconnect()
      if (registered) void window.electronAPI?.unregisterBrowserTarget?.(browserRegistrationId).catch(reportNativeError)
      if (webviewRef === webview) webviewRef = undefined
    }
  }

  const bindTauriPlaceholder = (element: HTMLDivElement) => {
    cleanupTauriTarget?.()
    let active = true
    let registering = false
    let registered = false
    let nativeVisible = false
    let registeredSessionId = ""
    let lastBounds = ""
    let unlistenNavigation = () => {}
    const bounds = () => {
      if (viewportMenuOpen() || document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')) return null
      const rect = element.getBoundingClientRect()
      const clip = frameWrapRef?.getBoundingClientRect() ?? rect
      const left = Math.max(rect.left, clip.left, 0)
      const top = Math.max(rect.top, clip.top, 0)
      const right = Math.min(rect.right, clip.right, window.innerWidth)
      const bottom = Math.min(rect.bottom, clip.bottom, window.innerHeight)
      if (right <= left || bottom <= top) return null
      return physicalBrowserBounds({ x: left, y: top, width: right - left, height: bottom - top }, window.devicePixelRatio)
    }
    const syncBounds = () => {
      const sessionId = props.sessionId
      if (!active || registering || !sessionId) return
      const next = bounds()
      if (!next) {
        lastBounds = ""
        if (registered && nativeVisible) {
          registering = true
          void updateTauriBrowserTarget(browserRegistrationId, undefined, false).then(() => {
            nativeVisible = false
          }).catch(reportNativeError).finally(() => {
            registering = false
            if (active) syncBounds()
          })
        }
        return
      }
      if (registered && registeredSessionId !== sessionId) {
        const previousId = browserRegistrationId
        browserRegistrationId = crypto.randomUUID()
        registering = true
        unlistenNavigation()
        unlistenNavigation = () => {}
        registered = false
        nativeVisible = false
        registeredSessionId = ""
        tauriRegistered = false
        void unregisterTauriBrowserTarget(previousId).catch(reportNativeError).finally(() => {
          registering = false
          if (active) syncBounds()
        })
        return
      }
      const serialized = JSON.stringify(next)
      if (registered && nativeVisible && serialized === lastBounds) return
      if (registered) {
        registering = true
        void updateTauriBrowserTarget(browserRegistrationId, next, true).then(() => {
          lastBounds = serialized
          nativeVisible = true
        }).catch((error) => {
          lastBounds = ""
          reportNativeError(error)
        }).finally(() => {
          registering = false
          if (active) syncBounds()
        })
        return
      }
      registering = true
      const target = nativeTarget()
      const registrationId = browserRegistrationId
      void onTauriBrowserNavigation(registrationId, (url) => {
        setNativeTarget(url)
        setPathInput(url)
        props.onFrameLocation?.(url)
      }).then(async (unlisten) => {
        if (!active) {
          unlisten()
          return
        }
        unlistenNavigation()
        unlistenNavigation = unlisten
        await registerTauriBrowserTarget({
          sessionId,
          registrationId,
          url: target,
          bounds: next,
        })
        registeredSessionId = sessionId
        lastBounds = serialized
        registering = false
        if (!active) {
          await unregisterTauriBrowserTarget(registrationId)
          return
        }
        registered = true
        nativeVisible = true
        tauriRegistered = true
        if (nativeTarget() !== target) {
          await controlTauriBrowserTarget(registrationId, "navigate", nativeTarget())
        }
        syncBounds()
      }).catch((error) => {
        registering = false
        lastBounds = ""
        reportNativeError(error)
      })
    }
    const resizeObserver = new ResizeObserver(syncBounds)
    const overlayObserver = new MutationObserver(syncBounds)
    resizeObserver.observe(element)
    overlayObserver.observe(document.body, { attributes: true, childList: true, subtree: true })
    createEffect(syncBounds)
    window.addEventListener("resize", syncBounds)
    window.addEventListener("scroll", syncBounds, true)
    queueMicrotask(syncBounds)
    cleanupTauriTarget = () => {
      active = false
      resizeObserver.disconnect()
      overlayObserver.disconnect()
      window.removeEventListener("resize", syncBounds)
      window.removeEventListener("scroll", syncBounds, true)
      unlistenNavigation()
      if (registered) void unregisterTauriBrowserTarget(browserRegistrationId).catch(reportNativeError)
      registered = false
      nativeVisible = false
      tauriRegistered = false
    }
  }

  createEffect(() => {
    const initialUrl = props.initialUrl
    const initialAddress = props.initialAddress
    untrack(() => {
      setFrameSrc(initialUrl)
      const address = initialAddress ?? getEditablePathFromUrl(initialUrl)
      setPathInput(address)
      if (nativeMode() && webviewRef?.getURL() === address) return
      const previousTarget = nativeTarget()
      setNativeTarget(address)
      const nextNativeMode = nativeBrowserAvailable
      if (nextNativeMode && browserHost === "tauri" && tauriRegistered && previousTarget !== address) {
        void controlTauriBrowserTarget(browserRegistrationId, "navigate", address).catch(reportNativeError)
      }
      setNativeMode(nextNativeMode)
    })
  })

  createEffect(() => {
    if (nativeMode()) return
    cleanupWebviewListeners?.()
    cleanupWebviewListeners = null
    cleanupTauriTarget?.()
    cleanupTauriTarget = null
  })

  createEffect(() => {
    props.commentMode
    attachCommentListeners()
  })

  onCleanup(() => {
    cleanupFrameListeners?.()
    cleanupWebviewListeners?.()
    cleanupTauriTarget?.()
  })

  const handleBack = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (nativeMode()) {
      if (browserHost === "tauri") void controlTauriBrowserTarget(browserRegistrationId, "back").catch(reportNativeError)
      else if (webviewRef?.canGoBack()) webviewRef.goBack()
      return
    }
    try {
      iframeRef?.contentWindow?.history.go(-1)
    } catch {
      // Ignore navigation errors from pages that do not expose history access.
    }
  }

  const handleRefresh = () => {
    if (nativeMode()) {
      if (browserHost === "tauri") void controlTauriBrowserTarget(browserRegistrationId, "reload").catch(reportNativeError)
      else webviewRef?.reload()
      return
    }
    try {
      iframeRef?.contentWindow?.location.reload()
      return
    } catch {
      // Fall back to resetting the iframe source if the frame cannot be reloaded directly.
    }
    setFrameSrc("about:blank")
    requestAnimationFrame(() => setFrameSrc(props.initialUrl))
  }

  const handleGo = async (event?: Event) => {
    event?.preventDefault()
    if (props.addressMode === "url" && props.onNavigate) {
      if (navigating()) return
      if (nativeBrowserAvailable) {
        try {
          const target = normalizeBrowserPreviewUrl(pathInput())
          setPathInput(target)
          setNativeTarget(target)
          if (nativeMode() && browserHost === "tauri") {
            void controlTauriBrowserTarget(browserRegistrationId, "navigate", target).catch(reportNativeError)
          } else if (nativeMode() && webviewRef) void webviewRef.loadURL(target).catch(reportNativeError)
          else {
            setNativeTarget(target)
            setNativeMode(true)
          }
          props.onFrameLocation?.(target)
        } catch {
          reportNativeError(new Error(props.labels.invalidUrl ?? props.labels.path))
        }
        return
      }
      const restoreNative = nativeMode()
      setNativeMode(false)
      setNavigating(true)
      try {
        setFrameSrc(await props.onNavigate(pathInput()))
      } catch (error) {
        setNativeMode(restoreNative)
        props.onNavigationError?.(error)
      } finally {
        setNavigating(false)
      }
      return
    }
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
        <Show when={props.lockedBaseLabel}>
          <div class="shrink-0 rounded-md px-3 py-1.5 text-sm" style={{ background: "var(--surface-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-base)" }}>
            {props.lockedBaseLabel}
          </div>
        </Show>
        <form class="flex min-w-0 flex-1 items-center gap-2" onSubmit={(event) => void handleGo(event)}>
          <input
            type="text"
            class="min-w-0 flex-1 rounded-md px-3 py-1.5 text-sm outline-none"
            style={{ background: "var(--surface-secondary)", color: "var(--text-primary)", border: "1px solid var(--border-base)" }}
            value={pathInput()}
            disabled={navigating()}
            onInput={(event) => setPathInput(event.currentTarget.value)}
            spellcheck={false}
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            aria-label={props.labels.path}
          />
          <button type="submit" class="new-tab-button" title={props.labels.go} aria-label={props.labels.go} disabled={navigating()}>
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
            class="new-tab-button icon-toggle"
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
          <Show when={!nativeMode()}>
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
              sandbox={framePolicy.sandbox}
              onLoad={syncPathInputFromFrame}
            />
          </Show>
          <Show when={nativeMode() && browserHost === "electron"}>
            {/* Electron's shadow iframe needs its :host display:flex to fill the webview height. */}
            <webview
              ref={bindWebview}
              src={nativeTarget()}
              partition={`persist:codenomad-browser-${props.sessionId}`}
              allowpopups
              class={isResponsiveViewport() ? "border-0 bg-surface" : "border-0 bg-surface shadow-xl"}
              style={{
                width: viewport().width ? `${viewport().width}px` : "100%",
                height: viewport().height ? `${viewport().height}px` : "100%",
                margin: viewport().width ? "0 auto" : "0",
              }}
            />
          </Show>
          <Show when={nativeMode() && browserHost === "tauri"}>
            <div
              ref={bindTauriPlaceholder}
              title={props.title}
              class={isResponsiveViewport() ? "bg-surface" : "bg-surface shadow-xl"}
              style={{
                width: viewport().width ? `${viewport().width}px` : "100%",
                height: viewport().height ? `${viewport().height}px` : "100%",
                margin: viewport().width ? "0 auto" : "0",
              }}
            />
          </Show>
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
