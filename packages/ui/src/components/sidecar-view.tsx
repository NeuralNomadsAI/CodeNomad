import { ArrowLeft, ArrowRight, RefreshCw } from "lucide-solid"
import { createEffect, createMemo, createSignal, type Component } from "solid-js"
import type { SideCarTabRecord } from "../stores/sidecars"
import { useI18n } from "../lib/i18n"

interface SideCarViewProps {
  tab: SideCarTabRecord
}

export const SideCarView: Component<SideCarViewProps> = (props) => {
  const { t } = useI18n()
  const [frameSrc, setFrameSrc] = createSignal(props.tab.shellUrl)
  const [pathInput, setPathInput] = createSignal("/")
  let iframeRef: HTMLIFrameElement | undefined

  const lockedBaseLabel = createMemo(() => {
    const hostLabel = props.tab.port ? `${props.tab.name}:${props.tab.port}` : props.tab.name
    if (props.tab.prefixMode === "preserve") {
      return `${hostLabel}${props.tab.proxyBasePath}`
    }
    return hostLabel
  })

  const getEditablePathFromUrl = (url: string): string => {
    try {
      const parsed = new URL(url, window.location.origin)
      const basePath = props.tab.proxyBasePath
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
      if (!segment || segment === ".") {
        continue
      }
      if (segment === "..") {
        if (safeSegments.length > 0) {
          safeSegments.pop()
        }
        continue
      }
      safeSegments.push(segment)
    }

    const normalizedPath = `/${safeSegments.join("/")}` || "/"
    const basePath = props.tab.proxyBasePath
    return `${basePath}${normalizedPath}${parsed.search}${parsed.hash}`
  }

  const syncPathInputFromFrame = () => {
    try {
      const currentHref = iframeRef?.contentWindow?.location.href
      if (!currentHref) {
        return
      }
      setPathInput(getEditablePathFromUrl(currentHref))
    } catch {
      setPathInput(getEditablePathFromUrl(frameSrc()))
    }
  }

  createEffect(() => {
    setFrameSrc(props.tab.shellUrl)
    setPathInput(getEditablePathFromUrl(props.tab.shellUrl))
  })

  const handleBack = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()

    try {
      const frameWindow = iframeRef?.contentWindow
      if (!frameWindow) {
        return
      }

      if (frameWindow.history.length <= 1) {
        return
      }

      frameWindow.focus()
      frameWindow.history.go(-1)
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
    requestAnimationFrame(() => setFrameSrc(props.tab.shellUrl))
  }

  const handleGo = (event?: Event) => {
    event?.preventDefault()

    const nextUrl = buildNormalizedTargetUrl(pathInput())
    setFrameSrc(nextUrl)
    setPathInput(getEditablePathFromUrl(nextUrl))
  }

  return (
    <div class="flex h-full min-h-0 w-full flex-col bg-surface">
      <div
        class="flex shrink-0 items-center gap-2 px-3 py-2"
        style={{ "border-bottom": "1px solid var(--border-base)" }}
      >
        <button
          type="button"
          class="new-tab-button"
          onClick={handleBack}
          title={t("sidecars.back")}
          aria-label={t("sidecars.back")}
        >
          <ArrowLeft class="h-4 w-4" />
        </button>
        <button
          type="button"
          class="new-tab-button"
          onClick={handleRefresh}
          title={t("sidecars.refresh")}
          aria-label={t("sidecars.refresh")}
        >
          <RefreshCw class="h-4 w-4" />
        </button>
        <div
          class="shrink-0 rounded-md px-3 py-1.5 text-sm"
          style={{
            background: "var(--surface-secondary)",
            color: "var(--text-secondary)",
            border: "1px solid var(--border-base)",
          }}
        >
          {lockedBaseLabel()}
        </div>
        <form class="flex min-w-0 flex-1 items-center gap-2" onSubmit={(event) => handleGo(event)}>
          <input
            type="text"
            class="min-w-0 flex-1 rounded-md px-3 py-1.5 text-sm outline-none"
            style={{
              background: "var(--surface-secondary)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-base)",
            }}
            value={pathInput()}
            onInput={(event) => setPathInput(event.currentTarget.value)}
            spellcheck={false}
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            aria-label={t("sidecars.path")}
          />
          <button
            type="submit"
            class="new-tab-button"
            title={t("sidecars.go")}
            aria-label={t("sidecars.go")}
          >
            <ArrowRight class="h-4 w-4" />
          </button>
        </form>
      </div>
      <iframe
        ref={iframeRef}
        src={frameSrc()}
        title={props.tab.name}
        class="min-h-0 flex-1 w-full border-0 bg-surface"
        referrerPolicy="same-origin"
        onLoad={syncPathInputFromFrame}
      />
    </div>
  )
}
