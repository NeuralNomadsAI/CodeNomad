import { Show, createSignal, type Component } from "solid-js"
import type { LocationRef } from "@opencode/client"
import { activeInstanceId } from "../../stores/instances"
import { useI18n } from "../../lib/i18n"
import { ProviderManagerModal } from "../provider-auth/provider-manager-modal"
import { WebSearchSettingsCard } from "./websearch-settings-card"

interface ProvidersSettingsSectionProps {
  instanceId?: string
  location?: LocationRef
}

// Window-lifetime fold state: switching Settings sections keeps each group as the user left it.
const [modelsOpen, setModelsOpen] = createSignal(true)
const [webSearchOpen, setWebSearchOpen] = createSignal(false)

/** Models and Web search are the shared Settings disclosures; Web search starts folded. */
export const ProvidersSettingsSection: Component<ProvidersSettingsSectionProps> = (props) => {
  const { t } = useI18n()
  const instanceId = () => props.instanceId ?? activeInstanceId() ?? ""
  return <div class="settings-section-stack">
    <div class="settings-card settings-group-card">
      <details class="settings-disclosure" open={modelsOpen()} onToggle={event => setModelsOpen(event.currentTarget.open)}>
        <summary><h3 id="providers-models-heading">{t("settings.providers.models.title")}</h3></summary>
        <section aria-labelledby="providers-models-heading">
          <ProviderManagerModal instanceId={instanceId()} location={props.location} embedded />
        </section>
      </details>
    </div>
    <div class="settings-card settings-group-card">
      <details class="settings-disclosure" open={webSearchOpen()} onToggle={event => setWebSearchOpen(event.currentTarget.open)}>
        <summary><h3 id="providers-websearch-heading">{t("settings.websearch.title")}</h3></summary>
        {/* Search connections and defaults are read only while this group is open. */}
        <Show when={webSearchOpen()}>
          <WebSearchSettingsCard instanceId={instanceId()} location={props.location} embedded />
        </Show>
      </details>
    </div>
  </div>
}
