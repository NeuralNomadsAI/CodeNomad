import { Component, For, Show, createMemo, createSignal } from "solid-js"
import { Dynamic } from "solid-js/web"
import {
  DragDropProvider,
  DragDropSensors,
  SortableProvider,
  closestCenter,
  createSortable,
  type DragEvent as SolidDndDragEvent,
} from "@thisbeyond/solid-dnd"
import InstanceTab from "./instance-tab"
import KeyboardHint from "./keyboard-hint"
import ToastHistoryPanel from "./toast-history-panel"
import { Plus, MonitorUp, Bell, BellOff, Settings } from "lucide-solid"
import { keyboardRegistry } from "../lib/keyboard-registry"
import { useI18n } from "../lib/i18n"
import { isOsNotificationSupportedSync } from "../lib/os-notifications"
import { canOpenRemoteWindows } from "../lib/runtime-env"
import { getUnreadToastCountSignal } from "../lib/notifications"
import { useConfig } from "../stores/preferences"
import { openSettings } from "../stores/settings-screen"
import type { AppTabRecord } from "../stores/app-tabs"

interface InstanceTabsProps {
  tabs: AppTabRecord[]
  activeTabId: string | null
  onSelect: (tabId: string) => void
  onClose: (tabId: string) => void
  onNew: () => void
  onMoveTab: (tabId: string, targetTabId: string, placement: "before" | "after") => void
}

interface SortableAppTabProps {
  tab: AppTabRecord
  activeTabId: string | null
  onSelect: (tabId: string) => void
  onClose: (tabId: string) => void
}

const SortableAppTab: Component<SortableAppTabProps> = (props) => {
  const sortable = createSortable(props.tab.id)

  return (
    <div
      ref={sortable}
      class={`tab-draggable ${sortable.isActiveDraggable ? "tab-draggable-active" : ""}`}
      data-app-tab-id={props.tab.id}
    >
      {props.tab.kind === "instance" ? (
        <InstanceTab
          instance={props.tab.instance}
          active={props.tab.id === props.activeTabId}
          onSelect={() => props.onSelect(props.tab.id)}
          onClose={() => props.onClose(props.tab.id)}
        />
      ) : (
        <div
          class={`tab-pill ${props.tab.id === props.activeTabId ? "tab-pill-active" : ""}`}
          role="tab"
          tabIndex={0}
          aria-selected={props.tab.id === props.activeTabId}
          onClick={() => props.onSelect(props.tab.id)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return
            event.preventDefault()
            props.onSelect(props.tab.id)
          }}
        >
          <span class="tab-pill-button">
            <span class="truncate max-w-[180px]">{props.tab.sidecarTab.name}</span>
          </span>
          <button
            class="tab-pill-close"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              props.onClose(props.tab.id)
            }}
            aria-label={props.tab.sidecarTab.name}
          >
            ×
          </button>
        </div>
      )}
    </div>
  )
}

const InstanceTabs: Component<InstanceTabsProps> = (props) => {
  const { t } = useI18n()
  const { preferences } = useConfig()
  const tabIds = createMemo(() => props.tabs.map((tab) => tab.id))

  /** 是否顯示 Toast 歷史面板 / Whether to show toast history panel */
  const [showToastHistory, setShowToastHistory] = createSignal(false)

  const notificationsSupported = createMemo(() => isOsNotificationSupportedSync())
  const notificationsEnabled = createMemo(() => Boolean(preferences().osNotificationsEnabled))
  const notificationIcon = createMemo(() => {
    if (!notificationsSupported()) return BellOff
    return notificationsEnabled() ? Bell : BellOff
  })

  /** 未讀通知數量（響應式信號）/ Unread notification count (reactive signal) */
  const unreadCount = getUnreadToastCountSignal()

  const notificationTitle = createMemo(() => {
    if (!notificationsSupported()) return t("settings.notifications.status.unsupported")
    return notificationsEnabled()
      ? t("settings.notifications.status.enabled")
      : t("settings.notifications.status.disabled")
  })

  const handleDragEnd = ({ draggable, droppable }: SolidDndDragEvent) => {
    if (!droppable) return

    const tabId = String(draggable.id)
    const targetTabId = String(droppable.id)
    if (tabId === targetTabId) return

    const fromIndex = props.tabs.findIndex((tab) => tab.id === tabId)
    const toIndex = props.tabs.findIndex((tab) => tab.id === targetTabId)
    if (fromIndex < 0 || toIndex < 0) return

    props.onMoveTab(tabId, targetTabId, fromIndex < toIndex ? "after" : "before")
  }

  return (
    <>
      <div class="tab-bar tab-bar-instance">
        <div class="tab-container" role="tablist">
          <div class="tab-scroll">
            <div class="tab-strip">
              <div class="tab-strip-tabs">
                <DragDropProvider collisionDetector={closestCenter} onDragEnd={handleDragEnd}>
                  <DragDropSensors>
                    <SortableProvider ids={tabIds()}>
                      <For each={props.tabs}>
                        {(tab) => (
                          <SortableAppTab
                            tab={tab}
                            activeTabId={props.activeTabId}
                            onSelect={props.onSelect}
                            onClose={props.onClose}
                          />
                        )}
                      </For>
                    </SortableProvider>
                  </DragDropSensors>
                </DragDropProvider>
              </div>
              <div class="tab-strip-spacer" />
              <Show when={props.tabs.length > 1}>
                <div class="tab-shortcuts">
                  <KeyboardHint
                    shortcuts={[keyboardRegistry.get("instance-prev")!, keyboardRegistry.get("instance-next")!].filter(
                      Boolean,
                    )}
                  />
                </div>
              </Show>

              <button
                class="new-tab-button"
                onClick={props.onNew}
                title={t("instanceTabs.new.title")}
                aria-label={t("instanceTabs.new.ariaLabel")}
              >
                <Plus class="w-4 h-4" />
              </button>

              <button
                class="new-tab-button"
                onClick={() => openSettings("appearance")}
                title={t("settings.open.title")}
                aria-label={t("settings.open.ariaLabel")}
              >
                <Settings class="w-4 h-4" />
              </button>

              {/* 通知按鈕 / Notification Button */}
              <div class="relative">
                <button
                  class={`new-tab-button ${!notificationsSupported() ? "opacity-50" : ""}`}
                  onClick={() => setShowToastHistory(true)}
                  title={notificationTitle()}
                  aria-label={notificationTitle()}
                >
                  <Dynamic component={notificationIcon()} class="w-4 h-4" />
                </button>
                {/* 未讀標記 / Unread badge */}
                <Show when={unreadCount() > 0}>
                  <span
                    class="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground"
                    aria-label={t("toastHistory.unread", { count: unreadCount() })}
                  >
                    {unreadCount() > 9 ? "9+" : unreadCount()}
                  </span>
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
          </div>
        </div>
      </div>

      {/* Toast 歷史面板 / Toast History Panel */}
      <Show when={showToastHistory()}>
        <ToastHistoryPanel
          onClose={() => setShowToastHistory(false)}
          onOpenSettings={() => {
            setShowToastHistory(false)
            openSettings("notifications")
          }}
        />
      </Show>
    </>
  )
}

export default InstanceTabs
