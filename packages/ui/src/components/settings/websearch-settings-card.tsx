import { For, Show } from "solid-js"
import { Globe } from "lucide-solid"
import type { LocationRef } from "@opencode/client"
import type { WebSearchSelection } from "../../../../server/src/api-types"
import { useI18n } from "../../lib/i18n"
import { useWebSearchSettings } from "./useWebSearchSettings"
import { WebSearchProviderConnections } from "./websearch-provider-connections"

const encode = (value: WebSearchSelection) => value === null ? "default" : value === false ? "off" : `provider:${value}`
const decode = (value: string): WebSearchSelection => value === "default" ? null : value === "off" ? false : value.slice(9)

export function WebSearchSettingsCard(props: { instanceId: string; location?: LocationRef }) {
  const { t } = useI18n()
  const settings = useWebSearchSettings(props)
  const label = (value: WebSearchSelection) => value === null ? t("settings.websearch.default")
    : value === false ? t("settings.websearch.off") : value === "random" ? t("settings.websearch.random")
      : settings.providers().find(item => item.id === value)?.name ?? value

  return <section class="providers-settings-group websearch-settings" aria-labelledby="providers-websearch-heading">
    <header class="settings-card-heading-with-icon">
      <Globe class="settings-card-heading-icon" aria-hidden="true" />
      <h3 id="providers-websearch-heading" class="settings-card-title">{t("settings.websearch.title")}</h3>
    </header>
    <Show when={settings.error()}><p role="alert">{t("settings.websearch.error")}</p></Show>
    <WebSearchProviderConnections providers={settings.providers()} integrations={settings.integrations()}
      contextKey={`${props.instanceId}:${settings.location().directory}`} busy={settings.busy()}
      onRefresh={settings.refresh} onConnect={settings.connect} onRemove={settings.remove} />
    <Show when={settings.snapshot()}>{data => <div class="websearch-settings-defaults">
      <div class="websearch-settings-scopes">
        <For each={data().scopes}>{entry => <label class="settings-toggle-row settings-toggle-row-compact">
          <span class="providers-card-copy">
            <span class="settings-toggle-title" title={entry.path}>{t(`settings.websearch.${entry.scope}`)}</span>
          </span>
          <select class="selector-trigger" aria-label={t(`settings.websearch.${entry.scope}`)}
            title={entry.scope === "project" ? t("settings.websearch.effective", { provider: label(data().effective) }) : t("settings.websearch.defaultHint")}
            disabled={settings.busy()} value={encode(entry.selection)}
            onChange={event => void settings.save(entry.scope, decode(event.currentTarget.value))}>
            <option value="default" selected={entry.selection === null}>{t("settings.websearch.default")}</option>
            <option value="off" selected={entry.selection === false}>{t("settings.websearch.off")}</option>
            <option value="provider:random" selected={entry.selection === "random"}>{t("settings.websearch.random")}</option>
            <For each={settings.providers()}>{provider => <option value={`provider:${provider.id}`} selected={entry.selection === provider.id}>{provider.name}</option>}</For>
            <Show when={typeof entry.selection === "string" && entry.selection !== "random" && !settings.providers().some(item => item.id === entry.selection)}>
              <option value={encode(entry.selection)} selected>{String(entry.selection)}</option>
            </Show>
          </select>
        </label>}</For>
      </div>
      <p class="settings-toggle-caption">{t("settings.websearch.defaultHint")}</p>
    </div>}</Show>
  </section>
}
