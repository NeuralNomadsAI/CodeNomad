import { Component, For, Show, createMemo } from "solid-js"
import { Dynamic } from "solid-js/web"
import InstanceTab from "./instance-tab"
import KeyboardHint from "./keyboard-hint"
import { Plus, MonitorUp, Bell, BellOff, Settings } from "lucide-solid"
import { keyboardRegistry } from "../lib/keyboard-registry"
import { useI18n } from "../lib/i18n"
import { isOsNotificationSupportedSync } from "../lib/os-notifications"
import { useConfig } from "../stores/preferences"
import { openSettings } from "../stores/settings-screen"
import type { AppTabRecord } from "../stores/app-tabs"

interface InstanceTabsProps {
  tabs: AppTabRecord[]
  activeTabId: string | null
  onSelect: (tabId: string) => void
  onClose: (tabId: string) => void
  onNew: () => void
}

const InstanceTabs: Component<InstanceTabsProps> = (props) => {
  const { t } = useI18n()
  const { preferences } = useConfig()

  const notificationsSupported = createMemo(() => isOsNotificationSupportedSync())
  const notificationsEnabled = createMemo(() => Boolean(preferences().osNotificationsEnabled))
  const notificationIcon = createMemo(() => {
    if (!notificationsSupported()) return BellOff
    return notificationsEnabled() ? Bell : BellOff
  })

  const notificationTitle = createMemo(() => {
    if (!notificationsSupported()) return t("settings.notifications.status.unsupported")
    return notificationsEnabled()
      ? t("settings.notifications.status.enabled")
      : t("settings.notifications.status.disabled")
  })

  return (
    <div class="tab-bar tab-bar-instance">
      <div class="tab-container" role="tablist">
        <div class="tab-scroll">
          <div class="tab-strip">
            <div class="tab-strip-tabs">
              <For each={props.tabs}>
                {(tab) =>
                  tab.kind === "instance" ? (
                    <InstanceTab
                      instance={tab.instance}
                      active={tab.id === props.activeTabId}
                      onSelect={() => props.onSelect(tab.id)}
                      onClose={() => props.onClose(tab.id)}
                    />
                  ) : (
                    <div class={`tab-pill ${tab.id === props.activeTabId ? "tab-pill-active" : ""}`}>
                      <button class="tab-pill-button" onClick={() => props.onSelect(tab.id)}>
                        <span class="truncate max-w-[180px]">{tab.sidecarTab.name}</span>
                      </button>
                      <button class="tab-pill-close" onClick={() => props.onClose(tab.id)} aria-label={tab.sidecarTab.name}>
                        ×
                      </button>
                    </div>
                  )}
              </For>
              <button
                class="new-tab-button"
                onClick={props.onNew}
                title={t("instanceTabs.new.title")}
                aria-label={t("instanceTabs.new.ariaLabel")}
              >
                <Plus class="w-4 h-4" />
              </button>
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
               onClick={() => openSettings("appearance")}
               title={t("settings.open.title")}
               aria-label={t("settings.open.ariaLabel")}
             >
               <Settings class="w-4 h-4" />
             </button>

             <button
               class={`new-tab-button ${!notificationsSupported() ? "opacity-50" : ""}`}
               onClick={() => openSettings("notifications")}
               title={notificationTitle()}
               aria-label={notificationTitle()}
             >
              <Dynamic component={notificationIcon()} class="w-4 h-4" />
            </button>

             <button
               class="new-tab-button tab-remote-button"
               onClick={() => openSettings("remote")}
               title={t("instanceTabs.remote.title")}
               aria-label={t("instanceTabs.remote.ariaLabel")}
             >
               <MonitorUp class="w-4 h-4" />
             </button>
          </div>
        </div>
      </div>
    </div>

  )
}

export default InstanceTabs
