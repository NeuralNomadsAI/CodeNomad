import { Select } from "@kobalte/core/select"
import { For, Show, createEffect, createMemo, createSignal } from "solid-js"
import { ChevronDown, KeyRound, RefreshCw, X } from "lucide-solid"
import type { IntegrationInfo, WebSearchProvider } from "@opencode/client"
import { useI18n } from "../../lib/i18n"

interface Props {
  providers: WebSearchProvider[]
  integrations: IntegrationInfo[]
  contextKey: string
  busy: boolean
  onRefresh: () => void
  onConnect: (integrationID: string, key: string) => Promise<boolean>
  onRemove: (credentialID: string) => Promise<boolean>
}

export function WebSearchProviderConnections(props: Props) {
  const { t } = useI18n()
  const [selectedId, setSelectedId] = createSignal("")
  const [activeId, setActiveId] = createSignal("")
  const [key, setKey] = createSignal("")
  const options = createMemo(() => props.integrations.filter(item => props.providers.some(provider => provider.id === item.id)))
  const selected = () => options().find(item => item.id === selectedId()) ?? options()[0]
  const active = () => options().find(item => item.id === activeId())
  const configured = () => options().filter(item => item.connections.length > 0)
  createEffect(() => {
    props.contextKey
    setSelectedId(""); setActiveId(""); setKey("")
  })
  const close = () => { setActiveId(""); setKey("") }
  const connect = async () => {
    const item = active(), context = props.contextKey
    if (!item || props.busy || !key().trim()) return
    if (await props.onConnect(item.id, key()) && props.contextKey === context) close()
  }
  const source = (item: IntegrationInfo) => item.connections.map(connection => connection.type === "env"
    ? t("settings.websearch.environment", { name: connection.name }) : connection.label).join(" • ")

  return <div class="providers-manager-embedded websearch-provider-connections">
    <div class="providers-connect-bar">
      <Select<IntegrationInfo> options={options()} value={selected()} optionValue="id" optionTextValue="name"
        disabled={props.busy} onChange={option => option && setSelectedId(option.id)}
        itemComponent={itemProps => <Select.Item item={itemProps.item} class="selector-option selector-option--multiline">
          <div class="selector-option-content">
            <Select.ItemLabel class="selector-option-label">{itemProps.item.rawValue.name}</Select.ItemLabel>
            <div class="selector-option-description">{itemProps.item.rawValue.id}</div>
          </div>
        </Select.Item>}>
        <Select.Trigger class="selector-trigger providers-connect-select" aria-label={t("toolCall.websearch.provider")}>
          <div class="flex-1 min-w-0"><Select.Value<IntegrationInfo>>{state => <div class="selector-trigger-label selector-trigger-label--stacked flex-1 min-w-0">
            <span class="selector-trigger-primary selector-trigger-primary--align-left">{state.selectedOption()?.name ?? t("settings.providers.selectProvider")}</span>
            <Show when={state.selectedOption()}><span class="selector-trigger-secondary" dir="ltr">{state.selectedOption()?.id} • {t("settings.providers.method.api")}</span></Show>
          </div>}</Select.Value></div>
          <Select.Icon class="selector-trigger-icon"><ChevronDown class="w-3 h-3" /></Select.Icon>
        </Select.Trigger>
        <Select.Portal><Select.Content class="selector-popover"><Select.Listbox class="selector-listbox" /></Select.Content></Select.Portal>
      </Select>
      <button type="button" class="selector-button selector-button-primary" disabled={props.busy || !selected()?.methods.some(method => method.type === "key")}
        onClick={() => { setActiveId(selected()?.id ?? ""); setKey("") }}>{t("settings.providers.actions.connect")}</button>
      <button type="button" class="settings-pill-button" disabled={props.busy} onClick={props.onRefresh}>
        <RefreshCw class={props.busy ? "providers-spin-icon" : "providers-button-icon"} />{t("settings.providers.refresh")}
      </button>
    </div>

    <Show when={active()}>{item => <section class="providers-connect-panel">
      <div class="providers-panel-header">
        <h4 class="settings-card-title">{t("settings.providers.auth.title", { provider: item().name })}</h4>
        <button type="button" class="selector-button selector-button-secondary settings-screen-close" disabled={props.busy}
          aria-label={t("settings.providers.actions.close")} onClick={close}><X class="w-4 h-4" /></button>
      </div>
      <label class="providers-field"><span class="settings-form-label">{t("settings.providers.apiKey.label")}</span>
        <div class="providers-input-wrap"><KeyRound class="providers-input-icon" aria-hidden="true" />
          <input type="password" class="providers-input" value={key()} disabled={props.busy} autocomplete="off"
            placeholder={t("settings.providers.apiKey.placeholder")} onInput={event => setKey(event.currentTarget.value)} />
        </div>
      </label>
      <div class="providers-actions-row"><button type="button" class="selector-button selector-button-primary"
        disabled={props.busy || !key().trim()} onClick={() => void connect()}>{t("settings.providers.actions.connect")}</button></div>
    </section>}</Show>

    <section class="providers-list-section">
      <Show when={!props.busy && configured().length === 0}><p class="settings-card-message">{t("settings.providers.empty.noConfiguredProviders")}</p></Show>
      <div class="providers-grid"><For each={configured()}>{item => <article class="providers-card settings-toggle-row settings-toggle-row-compact">
        <div class="providers-card-copy">
          <h5 class="providers-card-title">{item.name}</h5>
          <p class="providers-card-meta" title={source(item)}><bdi dir="ltr">{item.id}</bdi> • {source(item)}</p>
        </div>
        <div class="provider-model-card-actions"><For each={item.connections.filter(connection => connection.type === "credential")}>{connection =>
          <button type="button" class="selector-button selector-button-secondary providers-disconnect-button" disabled={props.busy}
            title={connection.label} aria-label={`${t("settings.providers.actions.remove")}: ${item.name} — ${connection.label}`}
            onClick={() => { if (connection.type === "credential") void props.onRemove(connection.id) }}>{t("settings.providers.actions.disconnect")}</button>
        }</For></div>
      </article>}</For></div>
    </section>
  </div>
}
