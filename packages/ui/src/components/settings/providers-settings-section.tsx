import { type Component } from "solid-js"
import type { LocationRef } from "@opencode/client"
import { activeInstanceId } from "../../stores/instances"
import { useI18n } from "../../lib/i18n"
import { Boxes } from "lucide-solid"
import { ProviderManagerModal } from "../provider-auth/provider-manager-modal"
import { WebSearchSettingsCard } from "./websearch-settings-card"

interface ProvidersSettingsSectionProps {
  instanceId?: string
  location?: LocationRef
}

export const ProvidersSettingsSection: Component<ProvidersSettingsSectionProps> = (props) => {
  const { t } = useI18n()
  const instanceId = () => props.instanceId ?? activeInstanceId() ?? ""
  return <div class="settings-section-stack">
    <section class="providers-settings-group" aria-labelledby="providers-models-heading">
      <header class="settings-card-heading-with-icon">
        <Boxes class="settings-card-heading-icon" aria-hidden="true" />
        <h3 id="providers-models-heading" class="settings-card-title">{t("settings.providers.models.title")}</h3>
      </header>
      <ProviderManagerModal instanceId={instanceId()} location={props.location} embedded />
    </section>
    <WebSearchSettingsCard instanceId={instanceId()} location={props.location} />
  </div>
}
