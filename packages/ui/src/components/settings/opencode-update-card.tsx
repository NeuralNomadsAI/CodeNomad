import { createEffect, createResource, createSignal, Show, type Component } from "solid-js"
import { serverApi } from "../../lib/api-client"
import { useI18n } from "../../lib/i18n"
import { useConfig } from "../../stores/preferences"

export const OpenCodeUpdateCard: Component = () => {
  const { t } = useI18n()
  const { serverSettings } = useConfig()
  const [status, { mutate, refetch }] = createResource(
    () => serverSettings().opencodeBinary || "opencode2",
    () => serverApi.fetchOpenCodeUpdateStatus(),
  )
  const [updating, setUpdating] = createSignal(false)
  const [updatedVersion, setUpdatedVersion] = createSignal<string | null>(null)
  const [updateFailed, setUpdateFailed] = createSignal(false)

  createEffect(() => {
    serverSettings().opencodeBinary
    setUpdatedVersion(null)
    setUpdateFailed(false)
  })

  const handleUpdate = async () => {
    if (updating()) return
    const binary = serverSettings().opencodeBinary || "opencode2"
    setUpdating(true)
    setUpdateFailed(false)
    try {
      const result = await serverApi.updateOpenCode()
      if ((serverSettings().opencodeBinary || "opencode2") !== binary) return
      setUpdatedVersion(result.version)
      mutate({
        currentVersion: result.version,
        latestVersion: result.version,
        updateAvailable: false,
        canUpgrade: false,
      })
    } catch {
      if ((serverSettings().opencodeBinary || "opencode2") === binary) setUpdateFailed(true)
    } finally {
      setUpdating(false)
    }
  }
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

              <Show when={updateStatus().checkError}>
                <div class="settings-error-message" role="status">{t("settings.opencode.update.checkFailed")}</div>
                <div class="settings-info-actions">
                  <button type="button" class="settings-pill-button" onClick={() => void refetch()}>
                    {t("settings.opencode.update.retry")}
                  </button>
                </div>
              </Show>

              <Show when={!updateStatus().checkError}>
                <Show when={updateStatus().updateAvailable} fallback={
                  <div class="settings-toggle-caption" role="status">{t("settings.opencode.update.upToDate")}</div>
                }>
                  <Show
                    when={updateStatus().canUpgrade}
                    fallback={<div class="settings-toggle-caption">{t("settings.opencode.update.availableUnsupported", { version: updateStatus().latestVersion ?? "" })}</div>}
                  >
                    <div class="settings-info-actions">
                      <button
                        type="button"
                        class="settings-pill-button"
                        disabled={updating()}
                        onClick={() => void handleUpdate()}
                      >
                        {updating()
                          ? t("settings.opencode.update.updating")
                          : t("settings.opencode.update.action", { version: updateStatus().latestVersion ?? "" })}
                      </button>
                    </div>
                  </Show>
                </Show>
              </Show>
            </>
          )}
        </Show>
      </Show>
      <Show when={updatedVersion()}>
        {(version) => (
          <div class="settings-info-toast" role="status" aria-live="polite">
            {t("settings.opencode.update.success", { version: version() })}
          </div>
        )}
      </Show>
      <Show when={updateFailed()}>
        <div class="settings-error-message" role="alert">{t("settings.opencode.update.failed")}</div>
      </Show>
    </div>
  )
}
