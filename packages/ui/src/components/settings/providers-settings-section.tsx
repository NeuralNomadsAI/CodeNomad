import { Show, createSignal, type Component } from "solid-js"
import type { LocationRef } from "@opencode/client"
import { activeInstanceId } from "../../stores/instances"
import { useI18n } from "../../lib/i18n"
import { ProviderManagerModal } from "../provider-auth/provider-manager-modal"
import { WebSearchSettingsCard } from "./websearch-settings-card"
import { ImageSettingsCard } from "./image-settings-card"
import type { PreferencesProjectContext } from "./preferences-project-context"
import { ProviderCatalogue } from "./provider-catalogue"

interface ProvidersSettingsSectionProps {
  instanceId?: string
  location?: LocationRef
  active?: () => boolean
  scoped?: boolean
  executionContext?: PreferencesProjectContext
  catalogueContext?: PreferencesProjectContext
}

// Window-lifetime fold state: switching Settings sections keeps each group as the user left it.
const [modelsOpen, setModelsOpen] = createSignal(true)
const [webSearchOpen, setWebSearchOpen] = createSignal(false)
const [imagesOpen, setImagesOpen] = createSignal(false)

/** Models, Web search and Images are the shared Settings disclosures; Web search and Images start folded. */
export const ProvidersSettingsSection: Component<ProvidersSettingsSectionProps> = (props) => {
  const { t } = useI18n()
  const instanceId = () => props.instanceId ?? activeInstanceId() ?? ""
  const unavailable = () => <p class="settings-card-message" role="status">{t(props.catalogueContext ? "settings.execution.deferred" : "settings.execution.unavailable")}</p>
  return <div class="settings-section-stack">
    <div class="settings-card settings-group-card">
      <details class="settings-disclosure" open={modelsOpen()} onToggle={event => setModelsOpen(event.currentTarget.open)}>
        <summary><h3 id="providers-models-heading">{t("settings.providers.models.title")}</h3></summary>
        <section aria-labelledby="providers-models-heading">
          <Show when={modelsOpen()}>
            <Show when={props.scoped} fallback={<ProviderManagerModal instanceId={instanceId()} location={props.location} active={props.active} embedded />}>
              <Show when={props.executionContext} keyed fallback={<Show when={props.catalogueContext} keyed fallback={unavailable()}>
                {context => <ProviderCatalogue context={context} active={() => props.catalogueContext === context} />}
              </Show>}>{context => <ProviderManagerModal instanceId={context.instanceId!} location={context.location} active={() => props.executionContext === context} embedded />}</Show>
            </Show>
          </Show>
        </section>
      </details>
    </div>
    <div class="settings-card settings-group-card">
      <details class="settings-disclosure" open={webSearchOpen()} onToggle={event => setWebSearchOpen(event.currentTarget.open)}>
        <summary><h3 id="providers-websearch-heading">{t("settings.websearch.title")}</h3></summary>
        {/* Search connections and defaults are read only while this group is open. */}
        <Show when={webSearchOpen()}>
          <Show when={props.scoped} fallback={<WebSearchSettingsCard instanceId={instanceId()} location={props.location} active={props.active} embedded />}>
            <Show when={props.executionContext} keyed fallback={unavailable()}>{context => <WebSearchSettingsCard instanceId={context.instanceId!} location={context.location} active={() => props.executionContext === context} embedded />}</Show>
          </Show>
        </Show>
      </details>
    </div>
    <div class="settings-card settings-group-card">
      <details class="settings-disclosure" open={imagesOpen()} onToggle={event => setImagesOpen(event.currentTarget.open)}>
        <summary><h3 id="providers-images-heading">{t("settings.images.title")}</h3></summary>
        {/* The configuration contract and image models are read only while this group is open. */}
        <Show when={imagesOpen()}>
          <Show when={props.scoped} fallback={<ImageSettingsCard instanceId={instanceId()} location={props.location} active={props.active} />}>
            <Show when={props.executionContext} keyed fallback={unavailable()}>{context => <ImageSettingsCard instanceId={context.instanceId!} location={context.location} active={() => props.executionContext === context} />}</Show>
          </Show>
        </Show>
      </details>
    </div>
  </div>
}
