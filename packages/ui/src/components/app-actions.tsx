import { Component, Show, createEffect, createSignal, onCleanup } from "solid-js"
import { Bell, MonitorUp, Settings } from "lucide-solid"
import ToastHistoryPanel from "./toast-history-panel"
import { useI18n } from "../lib/i18n"
import { canOpenRemoteWindows } from "../lib/runtime-env"
import { getUnreadToastCountSignal } from "../lib/notifications"
import { openSettings, toggleSettings } from "../stores/settings-screen"

interface AppActionsProps {
  class: string
}

/** Settings, the notification history bell and Remote Access: the project tab bar's end, or the macOS title bar. */
const AppActions: Component<AppActionsProps> = (props) => {
  const { t } = useI18n()
  const [showToastHistory, setShowToastHistory] = createSignal(false)
  let notificationTriggerRef: HTMLButtonElement | undefined
  let notificationPopoverRef: HTMLDivElement | undefined

  createEffect(() => {
    if (!showToastHistory()) return
    queueMicrotask(() => notificationPopoverRef?.querySelector<HTMLElement>(".toast-history-panel button:not(:disabled)")?.focus())
    const closeOutside = (event: PointerEvent) => {
      if (!notificationPopoverRef?.contains(event.target as Node)) setShowToastHistory(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      setShowToastHistory(false)
      queueMicrotask(() => notificationTriggerRef?.focus())
    }
    document.addEventListener("pointerdown", closeOutside)
    document.addEventListener("keydown", closeOnEscape)
    onCleanup(() => {
      document.removeEventListener("pointerdown", closeOutside)
      document.removeEventListener("keydown", closeOnEscape)
    })
  })

  const unreadCount = getUnreadToastCountSignal()

  return (
    <div class={props.class} data-titlebar-interactive>
      <button
        class="new-tab-button"
        onClick={() => toggleSettings()}
        title={t("settings.open.title")}
        aria-label={t("settings.open.ariaLabel")}
      >
        <Settings class="w-4 h-4" />
      </button>

      <div ref={notificationPopoverRef} class="relative">
        <button
          ref={notificationTriggerRef}
          type="button"
          class="new-tab-button icon-toggle"
          onClick={() => setShowToastHistory((open) => !open)}
          title={t("toastHistory.title")}
          aria-label={t("toastHistory.title")}
          aria-expanded={showToastHistory()}
        >
          {/* The bell is the notification history, independent of system notifications. */}
          <Bell class="w-4 h-4" />
        </button>
        <Show when={unreadCount() > 0}>
          <span
            class="tab-notification-badge"
            aria-label={t("toastHistory.unread", { count: unreadCount() })}
          >
            {unreadCount() > 9 ? "9+" : unreadCount()}
          </span>
        </Show>
        <Show when={showToastHistory()}>
          <ToastHistoryPanel
            onClose={() => {
              setShowToastHistory(false)
              queueMicrotask(() => notificationTriggerRef?.focus())
            }}
            onOpenSettings={() => {
              setShowToastHistory(false)
              openSettings("notifications")
            }}
          />
        </Show>
      </div>

      <Show when={canOpenRemoteWindows()}>
        <button
          class="new-tab-button tab-remote-button"
          onClick={() => openSettings("remote")}
          title={t("instanceTabs.remote.title")}
          aria-label={t("instanceTabs.remote.ariaLabel")}
        >
          <MonitorUp class="w-4 h-4" />
        </button>
      </Show>
    </div>
  )
}

export default AppActions
