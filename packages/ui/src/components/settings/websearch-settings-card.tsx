import { For, Show, createEffect, createSignal, onCleanup, untrack } from "solid-js"
import { RefreshCw } from "lucide-solid"
import type { IntegrationInfo, LocationRef } from "@opencode/client"
import type { PluginControlScope, WebSearchSelection, WebSearchSettingsSnapshot } from "../../../../server/src/api-types"
import { serverApi } from "../../lib/api-client"
import { serverEvents } from "../../lib/server-events"
import { useI18n } from "../../lib/i18n"
import { getRootClient } from "../../stores/opencode-client"
import { getActiveCatalogLocation } from "../../stores/sessions"

const encode = (value: WebSearchSelection) => value === null ? "default" : value === false ? "off" : `provider:${value}`
const decode = (value: string): WebSearchSelection => value === "default" ? null : value === "off" ? false : value.slice(9)

export function WebSearchSettingsCard(props: { instanceId: string; location?: LocationRef }) {
  const { t } = useI18n()
  const [snapshot, setSnapshot] = createSignal<WebSearchSettingsSnapshot>()
  const [providers, setProviders] = createSignal<Array<{ id: string; name: string }>>([])
  const [integrations, setIntegrations] = createSignal<IntegrationInfo[]>([])
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal(false)
  const [keyProvider, setKeyProvider] = createSignal("")
  const [key, setKey] = createSignal("")
  // The provider manager already reads the whole native catalog for this
  // screen. Listing integrations again here duplicated that cost on mount and
  // on every credential/config event, so it is deferred until the disclosure
  // that actually needs it is opened.
  const [credentialsEngaged, setCredentialsEngaged] = createSignal(false)
  let refresh = () => {}
  let mutate: (operation: () => Promise<unknown>) => Promise<void> = async () => {}
  const location = () => props.location ?? getActiveCatalogLocation(props.instanceId)
  const integration = () => integrations().find(item => item.id === keyProvider())
  createEffect(() => {
    const instanceId = props.instanceId, directory = location().directory
    let disposed = false, reading = false, writing = false, trailing = false, revision = 0
    setSnapshot(undefined); setProviders([]); setIntegrations([]); setError(false); setKey(""); setKeyProvider("")
    if (!instanceId || !directory) return
    const load = async () => {
      if (disposed) return
      if (reading || writing) { trailing = true; return }
      reading = true; setBusy(true)
      do {
        trailing = false
        const captured = revision
        try {
          const client = getRootClient(instanceId)
          const withAccess = untrack(() => credentialsEngaged())
          const [next, catalog, access] = await Promise.all([
            serverApi.getWebSearchSettings(instanceId, directory),
            client.websearch.providers({ location: { directory } }),
            withAccess ? client.integration.list({ location: { directory } }) : undefined,
          ])
          if (!disposed && captured === revision && !trailing) {
            setSnapshot(next); setProviders(catalog.data)
            if (access) setIntegrations(access.data)
            setError(false)
          }
        } catch { if (!disposed && captured === revision && !trailing) setError(true) }
      } while (!disposed && !writing && trailing)
      reading = false
      if (!disposed && !writing) setBusy(false)
    }
    refresh = () => { void load() }
    mutate = async operation => {
      if (disposed || writing || reading) return
      writing = true; revision++; setBusy(true); setError(false)
      let failed = false
      try {
        await operation()
        if (!disposed) setKey("")
      } catch { failed = true }
      finally { writing = false; if (!disposed) setBusy(false) }
      if (!disposed) await load()
      if (!disposed && failed) setError(true)
    }
    const events = serverEvents.on("instance.event", payload => {
      if (payload.type === "instance.event" && payload.instanceId === instanceId
        && ["config.updated", "websearch.updated", "integration.updated", "credential.updated"].includes(payload.event.type)) refresh()
    })
    const status = serverEvents.on("instance.eventStatus", payload => {
      if (payload.type === "instance.eventStatus" && payload.instanceId === instanceId && payload.status === "connected") refresh()
    })
    const reconnect = serverEvents.onOpen(() => refresh())
    onCleanup(() => { disposed = true; events(); status(); reconnect() })
    void load()
  })
  const save = (scope: PluginControlScope, selection: string) => {
    const instanceId = props.instanceId, directory = location().directory
    if (directory) void mutate(() => serverApi.setWebSearchSettings(instanceId, { location: { directory }, scope, provider: decode(selection) }))
  }
  const label = (value: WebSearchSelection) => value === null ? t("settings.websearch.default")
    : value === false ? t("settings.websearch.off") : value === "random" ? t("settings.websearch.random")
      : providers().find(item => item.id === value)?.name ?? value
  return <section class="settings-card websearch-settings">
    <header class="websearch-settings-header">
      <h3 class="settings-card-title">{t("settings.websearch.title")}</h3>
      <button type="button" class="icon-button-compact" title={t("settings.providers.refresh")} aria-label={t("settings.providers.refresh")} disabled={busy()} onClick={() => refresh()}>
        <RefreshCw class="h-3.5 w-3.5" classList={{ "animate-spin": busy() }} aria-hidden="true" />
      </button>
    </header>
    <p class="settings-card-subtitle">{t("settings.websearch.description")}</p>
    <Show when={error()}><p role="alert">{t("settings.websearch.error")}</p></Show>
    <Show when={snapshot()}>{data => <>
      <p class="websearch-settings-effective">{t("settings.websearch.effective", { provider: label(data().effective) })}</p>
      <div class="websearch-settings-scopes">
      <For each={data().scopes}>{entry => <label>
        <span class="settings-form-label" title={entry.path}>{t(`settings.websearch.${entry.scope}`)}</span>
        <select class="selector-trigger" aria-label={t(`settings.websearch.${entry.scope}`)} disabled={busy()} value={encode(entry.selection)}
          onChange={event => save(entry.scope, event.currentTarget.value)}>
          <option value="default" selected={entry.selection === null}>{t("settings.websearch.default")}</option>
          <option value="off" selected={entry.selection === false}>{t("settings.websearch.off")}</option>
          <option value="provider:random" selected={entry.selection === "random"}>{t("settings.websearch.random")}</option>
          <For each={providers()}>{provider => <option value={`provider:${provider.id}`} selected={entry.selection === provider.id}>{provider.name}</option>}</For>
          <Show when={typeof entry.selection === "string" && entry.selection !== "random" && !providers().some(item => item.id === entry.selection)}>
            <option value={encode(entry.selection)} selected>{String(entry.selection)}</option>
          </Show>
        </select>
      </label>}</For>
      </div>
      <p class="settings-card-subtitle">{t("settings.websearch.defaultHint")}</p>
      <details class="websearch-settings-credentials" onToggle={event => {
        if (!event.currentTarget.open) return
        setCredentialsEngaged(true)
        refresh()
      }}>
      <summary>{t("settings.websearch.credentials")}</summary>
      <div class="websearch-settings-credentials-body">
      <p class="settings-card-subtitle">{t("settings.websearch.credentialsHint")}</p>
      <label><span class="settings-form-label">{t("toolCall.websearch.provider")}</span>
        <select class="selector-trigger" aria-label={t("toolCall.websearch.provider")} value={keyProvider()} disabled={busy()} onChange={event => { setKeyProvider(event.currentTarget.value); setKey("") }}>
          <option value="" selected={!keyProvider()}>{t("formRequest.selectPlaceholder")}</option>
          <For each={providers().filter(provider => integrations().some(item => item.id === provider.id && item.methods.some(method => method.type === "key")))}>
            {provider => <option value={provider.id} selected={keyProvider() === provider.id}>{provider.name}</option>}
          </For>
        </select>
      </label>
      <Show when={integration()}>{access => <>
        <For each={access().connections}>{connection => <div class="websearch-settings-connection">
          <span>{connection.type === "env" ? t("settings.websearch.environment", { name: connection.name }) : connection.label}</span>
          <Show when={connection.type === "credential"}><button type="button" class="selector-button" disabled={busy()} onClick={() => {
            if (connection.type !== "credential") return
            const client = getRootClient(props.instanceId), credentialID = connection.id
            void mutate(() => client.credential.remove({ credentialID }))
          }}>{t("settings.providers.actions.remove")}</button></Show>
        </div>}</For>
        <label>{t("settings.providers.apiKey.label")}<input type="password" class="form-request-input" value={key()} disabled={busy()}
          autocomplete="off" onInput={event => setKey(event.currentTarget.value)} /></label>
        <button type="button" class="selector-button" disabled={busy() || !key().trim()} onClick={() => {
          const client = getRootClient(props.instanceId), integrationID = keyProvider(), value = key()
          void mutate(() => client.integration.connect.key({ integrationID, key: value }))
        }}>{t("settings.configFiles.actions.save")}</button>
      </>}</Show>
      </div>
      </details>
    </>}</Show>
  </section>
}
