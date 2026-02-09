import { Dialog } from "@kobalte/core/dialog"
import { Component, Show, createEffect, createResource } from "solid-js"
import { showToastNotification } from "../lib/notifications"
import {
  getOsNotificationCapability,
  requestOsNotificationPermission,
  type OsNotificationPermission,
} from "../lib/os-notifications"
import { useConfig } from "../stores/preferences"

interface NotificationsSettingsModalProps {
  open: boolean
  onClose: () => void
}

function formatPermissionLabel(permission: OsNotificationPermission): string {
  switch (permission) {
    case "granted":
      return "Granted"
    case "denied":
      return "Denied"
    case "default":
      return "Not granted"
    case "unsupported":
      return "Unsupported"
    default:
      return String(permission)
  }
}

const NotificationsSettingsModal: Component<NotificationsSettingsModalProps> = (props) => {
  const { preferences, updatePreferences } = useConfig()

  const [capability, { refetch }] = createResource(() => getOsNotificationCapability())

  createEffect(() => {
    if (props.open) {
      void refetch()
    }
  })

  const handleEnableToggle = async (enabled: boolean) => {
    if (!enabled) {
      updatePreferences({ osNotificationsEnabled: false })
      return
    }

    const cap = capability()
    if (cap && !cap.supported) {
      showToastNotification({
        title: "Notifications",
        message: cap.info ?? "OS notifications are not supported in this environment.",
        variant: "warning",
      })
      updatePreferences({ osNotificationsEnabled: false })
      return
    }

    const permission = await requestOsNotificationPermission()
    if (permission !== "granted") {
      showToastNotification({
        title: "Notifications",
        message:
          permission === "denied"
            ? "Notification permission denied. Enable notifications in your system/browser settings."
            : "Notification permission not granted.",
        variant: "warning",
      })
      updatePreferences({ osNotificationsEnabled: false })
      return
    }

    updatePreferences({ osNotificationsEnabled: true })
    void refetch()
  }

  const handleRequestPermission = async () => {
    const cap = capability()
    if (cap && !cap.supported) {
      showToastNotification({
        title: "Notifications",
        message: cap.info ?? "Notifications are not supported in this environment.",
        variant: "warning",
      })
      return
    }

    const permission = await requestOsNotificationPermission()
    if (permission === "granted") {
      showToastNotification({
        title: "Notifications",
        message: "Permission granted. You can now enable notifications.",
        variant: "success",
        duration: 6000,
      })
      void refetch()
      return
    }

    showToastNotification({
      title: "Notifications",
      message:
        permission === "denied"
          ? "Permission denied. You may need to enable notifications in your system/browser settings."
          : "Permission not granted.",
      variant: "warning",
    })
    void refetch()
  }

  const supported = () => capability()?.supported ?? false
  const permissionLabel = () => formatPermissionLabel(capability()?.permission ?? "unsupported")
  const infoMessage = () => capability()?.info

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay class="modal-overlay" />
        <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
          <Dialog.Content class="modal-surface w-full max-w-xl max-h-[90vh] flex flex-col overflow-hidden">
            <header class="px-6 py-4 border-b" style={{ "border-color": "var(--border-base)" }}>
              <Dialog.Title class="text-xl font-semibold text-primary">Notifications</Dialog.Title>
            </header>

            <div class="flex-1 overflow-y-auto p-6 space-y-6">
              <div class="panel">
                <div class="panel-header">
                  <h3 class="panel-title">Session Status Notifications</h3>
                </div>

                <div class="panel-body space-y-4">
                  <div class="flex items-center justify-between gap-4">
                    <div>
                      <div class="text-sm font-semibold text-primary">Enable</div>
                      <div class="text-xs text-secondary">Permission: {permissionLabel()}</div>
                    </div>
                    <label class="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={Boolean(preferences().osNotificationsEnabled)}
                        disabled={!supported() && capability.state === "ready"}
                        onChange={(e) => void handleEnableToggle(e.currentTarget.checked)}
                      />
                      <span class="text-sm">Enabled</span>
                    </label>
                  </div>

                  <Show when={supported() && (capability()?.permission ?? "unsupported") !== "granted"}>
                    <div class="flex items-center justify-between gap-4">
                      <div class="text-sm text-primary">Request permission</div>
                      <button
                        type="button"
                        class="selector-button selector-button-secondary w-auto whitespace-nowrap"
                        onClick={() => void handleRequestPermission()}
                      >
                        Request
                      </button>
                    </div>
                  </Show>

                  <div class="flex items-center justify-between gap-4">
                    <div>
                      <div class="text-sm font-semibold text-primary">Notify when app is focused</div>
                    </div>
                    <label class="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={Boolean(preferences().osNotificationsAllowWhenVisible)}
                        disabled={!preferences().osNotificationsEnabled}
                        onChange={(e) => updatePreferences({ osNotificationsAllowWhenVisible: e.currentTarget.checked })}
                      />
                      <span class="text-sm">Enabled</span>
                    </label>
                  </div>

                  <Show when={Boolean(infoMessage())}>
                    <div class="text-xs text-secondary">{infoMessage()}</div>
                  </Show>

                  <Show when={!supported() && capability.state === "ready"}>
                    <div class="text-xs text-secondary">
                      Notifications are not supported in this environment. The bell icon stays disabled.
                    </div>
                  </Show>

                  <div class="border-t pt-4" style={{ "border-color": "var(--border-base)" }}>
                    <div class="text-sm font-semibold text-primary mb-2">Notify me when</div>
                    <div class="space-y-3">
                      <div class="flex items-center justify-between gap-4">
                        <div class="text-sm text-primary">Session needs input</div>
                        <label class="inline-flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={Boolean(preferences().notifyOnNeedsInput)}
                            disabled={!preferences().osNotificationsEnabled}
                            onChange={(e) => updatePreferences({ notifyOnNeedsInput: e.currentTarget.checked })}
                          />
                          <span class="text-sm">Enabled</span>
                        </label>
                      </div>

                      <div class="flex items-center justify-between gap-4">
                        <div class="text-sm text-primary">Session becomes idle</div>
                        <label class="inline-flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={Boolean(preferences().notifyOnIdle)}
                            disabled={!preferences().osNotificationsEnabled}
                            onChange={(e) => updatePreferences({ notifyOnIdle: e.currentTarget.checked })}
                          />
                          <span class="text-sm">Enabled</span>
                        </label>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div class="px-6 py-4 border-t flex justify-end" style={{ "border-color": "var(--border-base)" }}>
              <button type="button" class="selector-button selector-button-secondary" onClick={props.onClose}>
                Close
              </button>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  )
}

export default NotificationsSettingsModal
