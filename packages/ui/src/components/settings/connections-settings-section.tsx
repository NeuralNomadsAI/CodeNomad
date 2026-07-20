import { PlugZap } from "lucide-solid"
import { createMemo, createSignal, Show, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { canOpenRemoteWindows } from "../../lib/runtime-env"
import { activeInstanceId, instances } from "../../stores/instances"
import { ProviderManagerModal } from "../provider-auth/provider-manager-modal"
import { RemoteAccessSettingsSection } from "./remote-access-settings-section"
import { SavedRemoteServersCard } from "./saved-remote-servers-card"

export const ConnectionsSettingsSection: Component = () => {
  const { t } = useI18n()
  const [providerManagerOpen, setProviderManagerOpen] = createSignal(false)
  const providerInstance = createMemo(() => {
    const id = activeInstanceId()
    return id ? instances().get(id) ?? null : null
  })
  const providerInstanceLabel = createMemo(() => {
    const instance = providerInstance()
    if (!instance) return ""
    return `${instance.projectName || instance.folder} (${instance.id})`
  })

  return (
    <>
      <div class="settings-section-stack">
        <Show when={canOpenRemoteWindows()}>
          <RemoteAccessSettingsSection />
          <SavedRemoteServersCard />
        </Show>

        <div class="settings-card">
          <div class="settings-card-header">
            <div class="settings-card-heading-with-icon">
              <PlugZap class="settings-card-heading-icon" />
              <div>
                <h3 class="settings-card-title">{t("settings.providers.title")}</h3>
                <p class="settings-card-subtitle">{t("settings.providers.subtitle")}</p>
                <p class="settings-toggle-caption">
                  {providerInstance()
                    ? t("settings.providers.target", { workspace: providerInstanceLabel() })
                    : t("settings.providers.empty.noInstance")}
                </p>
              </div>
            </div>
            <button
              type="button"
              class="selector-button selector-button-secondary"
              disabled={providerInstance()?.status !== "ready" || !providerInstance()?.client}
              onClick={() => setProviderManagerOpen(true)}
            >
              <PlugZap class="w-4 h-4" />
              <span>{t("modelSelector.manageProviders")}</span>
            </button>
          </div>
        </div>
      </div>

      <ProviderManagerModal
        instanceId={providerInstance()?.id ?? ""}
        open={providerManagerOpen()}
        onOpenChange={setProviderManagerOpen}
      />
    </>
  )
}
