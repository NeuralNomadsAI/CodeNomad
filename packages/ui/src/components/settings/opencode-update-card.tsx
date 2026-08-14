import { createResource, Show, type Component } from "solid-js"
import { serverApi } from "../../lib/api-client"
import { useI18n } from "../../lib/i18n"
import { useConfig } from "../../stores/preferences"

export const OpenCodeUpdateCard: Component = () => {
  const { t } = useI18n()
  const { serverSettings } = useConfig()
  const [status, { refetch }] = createResource(
    () => serverSettings().opencodeBinary || "opencode2",
    () => serverApi.fetchOpenCodeUpdateStatus(),
  )
  return (
    <div class="settings-card">
      <div class="settings-card-header">
        <div>
          <h3 class="settings-card-title">{t("settings.opencode.update.title")}</h3>
          <p class="settings-card-subtitle">{t("settings.opencode.update.subtitle")}</p>
        </div>
        <span class="settings-scope-badge settings-scope-badge-server">{t("settings.scope.server")}</span>
      </div>

      <Show when={!status.loading} fallback={<div class="settings-toggle-caption">{t("settings.opencode.update.checking")}</div>}>
        <Show
          when={!status.error && status()}
          fallback={
            <div>
              <div class="settings-error-message" role="alert">{t("settings.opencode.update.checkFailed")}</div>
              <button type="button" class="settings-pill-button" onClick={() => void refetch()}>
                {t("settings.opencode.update.retry")}
              </button>
            </div>
          }
        >
          {(updateStatus) => (
            <>
              <div class="settings-info-grid">
                <div class="settings-info-row">
                  <span class="settings-info-label">{t("settings.opencode.update.installed")}</span>
                  <span class="settings-info-value">{updateStatus().currentVersion}</span>
                </div>
              </div>

            </>
          )}
        </Show>
      </Show>
    </div>
  )
}
