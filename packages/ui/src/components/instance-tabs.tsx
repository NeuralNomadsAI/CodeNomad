import { Component, For, Show, createMemo, createSignal } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { Instance } from "../types/instance"
import InstanceTab from "./instance-tab"
import KeyboardHint from "./keyboard-hint"
import { Plus, MonitorUp, Bell, BellOff } from "lucide-solid"
import { keyboardRegistry } from "../lib/keyboard-registry"
import { useI18n } from "../lib/i18n"
import { ThemeModeToggle } from "./theme-mode-toggle"
import NotificationsSettingsModal from "./notifications-settings-modal"
import { isOsNotificationSupportedSync } from "../lib/os-notifications"
import { useConfig } from "../stores/preferences"

interface InstanceTabsProps {
  instances: Map<string, Instance>
  activeInstanceId: string | null
  onSelect: (instanceId: string) => void
  onClose: (instanceId: string) => void
  onNew: () => void
  onOpenRemoteAccess?: () => void
}

const InstanceTabs: Component<InstanceTabsProps> = (props) => {
  const { t } = useI18n()
  const { preferences } = useConfig()
  const [notificationsOpen, setNotificationsOpen] = createSignal(false)

  const notificationsSupported = createMemo(() => isOsNotificationSupportedSync())
  const notificationsEnabled = createMemo(() => Boolean(preferences().osNotificationsEnabled))
  const notificationIcon = createMemo(() => {
    if (!notificationsSupported()) return BellOff
    return notificationsEnabled() ? Bell : BellOff
  })

  const notificationTitle = createMemo(() => {
    if (!notificationsSupported()) return "Notifications unsupported"
    return notificationsEnabled() ? "Notifications enabled" : "Notifications disabled"
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
            <ThemeModeToggle class="new-tab-button" />

            <button
              class={`new-tab-button ${!notificationsSupported() ? "opacity-50" : ""}`}
              onClick={() => setNotificationsOpen(true)}
              title={notificationTitle()}
              aria-label={notificationTitle()}
            >
              <Dynamic component={notificationIcon()} class="w-4 h-4" />
            </button>

            <Show when={Boolean(props.onOpenRemoteAccess)}>
              <button
                class="new-tab-button tab-remote-button"
                onClick={() => props.onOpenRemoteAccess?.()}
                title={t("instanceTabs.remote.title")}
                aria-label={t("instanceTabs.remote.ariaLabel")}
              >
                <MonitorUp class="w-4 h-4" />
              </button>
            </Show>
          </div>
        </div>
      </div>

      <NotificationsSettingsModal open={notificationsOpen()} onClose={() => setNotificationsOpen(false)} />
    </div>

  )
}

export default InstanceTabs
