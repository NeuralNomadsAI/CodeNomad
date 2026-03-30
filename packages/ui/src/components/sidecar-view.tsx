import { ArrowLeft, RefreshCw } from "lucide-solid"
import { createEffect, createSignal, type Component } from "solid-js"
import type { SideCarTabRecord } from "../stores/sidecars"
import { useI18n } from "../lib/i18n"

interface SideCarViewProps {
  tab: SideCarTabRecord
}

export const SideCarView: Component<SideCarViewProps> = (props) => {
  const { t } = useI18n()
  const [frameSrc, setFrameSrc] = createSignal(props.tab.shellUrl)
  let iframeRef: HTMLIFrameElement | undefined

  createEffect(() => {
    setFrameSrc(props.tab.shellUrl)
  })

  const handleBack = () => {
    try {
      iframeRef?.contentWindow?.history.back()
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

  return (
    <div class="relative h-full w-full">
      <div class="absolute left-3 top-3 z-10 flex gap-2">
        <button
          type="button"
          class="new-tab-button bg-panel/90 backdrop-blur-sm"
          onClick={handleBack}
          title={t("sidecars.back")}
          aria-label={t("sidecars.back")}
        >
          <ArrowLeft class="h-4 w-4" />
        </button>
        <button
          type="button"
          class="new-tab-button bg-panel/90 backdrop-blur-sm"
          onClick={handleRefresh}
          title={t("sidecars.refresh")}
          aria-label={t("sidecars.refresh")}
        >
          <RefreshCw class="h-4 w-4" />
        </button>
      </div>
      <iframe
        ref={iframeRef}
        src={frameSrc()}
        title={props.tab.name}
        class="h-full w-full border-0 bg-surface"
        referrerPolicy="same-origin"
      />
    </div>
  )
}
