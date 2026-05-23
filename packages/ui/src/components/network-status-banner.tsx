import { createEffect, createSignal, Show } from "solid-js"
import { isOnlineSignal } from "../lib/network-status"
import { useI18n } from "../lib/i18n"

export default function NetworkStatusBanner() {
  const { t } = useI18n()
  const [showRestored, setShowRestored] = createSignal(false)

  let restoredTimer: ReturnType<typeof setTimeout> | null = null
  let previousOnline = isOnlineSignal()()

  createEffect(() => {
    const online = isOnlineSignal()()
    if (online && !previousOnline) {
      if (restoredTimer !== null) clearTimeout(restoredTimer)
      setShowRestored(true)
      restoredTimer = setTimeout(() => {
        setShowRestored(false)
        restoredTimer = null
      }, 3000)
    } else if (!online) {
      if (restoredTimer !== null) {
        clearTimeout(restoredTimer)
        restoredTimer = null
      }
      setShowRestored(false)
    }
    previousOnline = online
  })

  return (
    <Show when={!isOnlineSignal()() || showRestored()}>
      <div
        role="status"
        aria-live="polite"
        class={`transition-all duration-300 text-center text-xs font-medium py-1 px-3 ${
          isOnlineSignal()()
            ? "bg-green-600/20 text-green-500"
            : "bg-amber-500/20 text-amber-500"
        }`}
      >
        {isOnlineSignal()() ? t("networkStatus.backOnline") : t("networkStatus.offline")}
      </div>
    </Show>
  )
}
