import { Component, For, Show, createMemo } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { Instance } from "../types/instance"
import InstanceTab from "./instance-tab"
import KeyboardHint from "./keyboard-hint"
import { Plus, MonitorUp, Bell, BellOff, Settings } from "lucide-solid"
import { keyboardRegistry } from "../lib/keyboard-registry"
import { useI18n } from "../lib/i18n"
import { isOsNotificationSupportedSync } from "../lib/os-notifications"
import { useConfig } from "../stores/preferences"
import { openSettings } from "../stores/settings-screen"

interface InstanceTabsProps {
  instances: Map<string, Instance>
  activeInstanceId: string | null
  onSelect: (instanceId: string) => void
  onClose: (instanceId: string) => void
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
              <For each={Array.from(props.instances.entries())}>
                {([id, instance]) => (
                  <InstanceTab
                    instance={instance}
                    active={id === props.activeInstanceId}
                    onSelect={() => props.onSelect(id)}
                    onClose={() => props.onClose(id)}
                  />
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
            <Show when={Array.from(props.instances.entries()).length > 1}>
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
