import { For, Show, createMemo, createSignal, onCleanup, onMount, type Accessor } from "solid-js"
import type { PanelExtensionCatalogEntry, PanelExtensionSummary } from "../../../../server/src/api-types"
import { panelExtensionsApi } from "../../lib/panel-extensions-api"
import { useI18n } from "../../lib/i18n"

export function ExtensionCatalog(props: {
  installed: Accessor<PanelExtensionSummary[]>; busy: Accessor<boolean>; verified: Accessor<boolean>
  inspect: (entry: PanelExtensionCatalogEntry) => void
}) {
  const { t } = useI18n()
  const [entries, setEntries] = createSignal<PanelExtensionCatalogEntry[]>([])
  const [loading, setLoading] = createSignal(false), [failed, setFailed] = createSignal(false), [query, setQuery] = createSignal("")
  let generation = 0, controller: AbortController | undefined
  const load = async (refresh = false) => {
    controller?.abort(); controller = new AbortController()
    const current = ++generation
    setLoading(true); setFailed(false)
    try {
      const catalog = await panelExtensionsApi.catalog(refresh, controller.signal)
      if (current === generation) setEntries(catalog.entries)
    } catch { if (current === generation) { setEntries([]); setFailed(true) } }
    finally { if (current === generation) setLoading(false) }
  }
  onMount(() => void load())
  onCleanup(() => { generation++; controller?.abort() })
  const filtered = createMemo(() => entries().filter(entry =>
    `${entry.manifest.name} ${entry.manifest.id} ${entry.description}`.toLocaleLowerCase().includes(query().trim().toLocaleLowerCase())))
  return <section class="panel-extension-catalog" aria-label={t("panelExtensions.catalog.title")} aria-busy={loading()}>
    <div class="panel-extension-actions">
      <h3>{t("panelExtensions.catalog.title")}</h3>
      <button type="button" class="right-panel-customization-button" disabled={loading() || props.busy()} onClick={() => void load(true)}>
        {t("instanceShell.rightPanel.actions.refresh")}
      </button>
    </div>
    <input type="search" class="panel-extension-search" aria-label={t("panelExtensions.catalog.search")} placeholder={t("panelExtensions.catalog.search")}
      value={query()} onInput={event => setQuery(event.currentTarget.value)} />
    <Show when={loading()}><p role="status">{t("panelExtensions.catalog.loading")}</p></Show>
    <Show when={failed()}><p role="alert">{t("panelExtensions.catalog.error")}</p></Show>
    <Show when={!loading() && !failed() && !filtered().length}><p role="status">{t("panelExtensions.catalog.empty")}</p></Show>
    <For each={filtered()}>{entry => {
      const installed = () => props.installed().find(value => value.manifest.id === entry.manifest.id)
      const same = () => installed()?.digest === entry.digest
      return <div class="panel-extension-row" role="group" aria-label={entry.manifest.name}>
        <strong>{entry.manifest.name} {entry.manifest.version}</strong>
        <p>{entry.description}</p>
        <span title={entry.manifest.repository}>{entry.manifest.author}</span>
        <div class="panel-extension-actions">
          <button type="button" class="right-panel-customization-button" disabled={props.busy() || loading() || same() || !entry.compatible || !props.verified()}
            onClick={() => props.inspect(entry)}>{t(!entry.compatible ? "panelExtensions.catalog.incompatible" : same() ? "panelExtensions.catalog.installed"
              : installed() ? "panelExtensions.catalog.replace" : "panelExtensions.catalog.install", { apiVersion: entry.manifest.apiVersion })}</button>
        </div>
      </div>
    }}</For>
  </section>
}
