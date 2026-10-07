import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { Download, FileArchive, RefreshCw, Trash2 } from "lucide-solid"
import type { PanelExtensionManifest, PanelExtensionCatalogEntry } from "../../../../server/src/api-types"
import { PANEL_EXTENSION_LIMITS } from "../../../../server/src/panel-extensions/contract"
import { panelExtensionsApi } from "../../lib/panel-extensions-api"
import { useI18n } from "../../lib/i18n"
import type { PanelExtensionsController } from "./use-panel-extensions"
import { ExtensionName } from "./extension-name"

export function ExtensionManager(props: { controller: PanelExtensionsController }) {
  const { t } = useI18n()
  const [busy, setBusy] = createSignal(false), [failed, setFailed] = createSignal(false), [acknowledged, setAcknowledged] = createSignal(false)
  const [preview, setPreview] = createSignal<{ manifest: PanelExtensionManifest; digest: string;
    source: { kind: "zip"; archive: string } | { kind: "catalog" }; previousDigest?: string }>()
  const [removal, setRemoval] = createSignal<{ id: string; digest: string }>()
  const [catalog, setCatalog] = createSignal<PanelExtensionCatalogEntry[]>([])
  const [loading, setLoading] = createSignal(false), [catalogFailed, setCatalogFailed] = createSignal(false), [query, setQuery] = createSignal("")
  let generation = 0, controller: AbortController | undefined
  let disposed = false
  onCleanup(() => { disposed = true; generation++; controller?.abort() })
  const load = async (refresh = false) => {
    controller?.abort(); controller = new AbortController()
    const current = ++generation
    setLoading(true); setCatalogFailed(false)
    try {
      const result = await panelExtensionsApi.catalog(refresh, controller.signal)
      if (current === generation) setCatalog(result.entries)
    } catch { if (current === generation) { setCatalog([]); setCatalogFailed(true) } }
    finally { if (current === generation) setLoading(false) }
  }
  onMount(() => void load())
  const rows = createMemo(() => {
    const installed = props.controller.entries()
    return [...installed.map(entry => ({ installed: entry, catalog: catalog().find(value => value.manifest.id === entry.manifest.id) })),
      ...catalog().filter(entry => !installed.some(value => value.manifest.id === entry.manifest.id)).map(entry => ({ installed: undefined, catalog: entry }))]
      .filter(row => {
        const manifest = row.installed?.manifest ?? row.catalog!.manifest
        return `${manifest.name} ${manifest.id} ${row.catalog?.description ?? ""}`.toLocaleLowerCase().includes(query().trim().toLocaleLowerCase())
      })
  })
  createEffect(() => {
    const pending = removal()
    if (pending && !props.controller.entries().some(entry => entry.manifest.id === pending.id && entry.digest === pending.digest)) setRemoval(undefined)
  })
  let picker!: HTMLInputElement
  const run = async (operation: () => Promise<unknown>) => {
    if (busy()) return
    setBusy(true); setFailed(false)
    try { await operation(); if (!disposed) await props.controller.refresh() } catch { if (!disposed) setFailed(true) }
    finally { if (!disposed) setBusy(false) }
  }
  const inspect = async (file: File | undefined) => {
    if (!file) return
    setPreview(undefined); setAcknowledged(false)
    await run(async () => {
      if (file.size > PANEL_EXTENSION_LIMITS.archiveBytes) throw new Error("limit")
      const archive = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(",")[1])
        reader.onerror = reject
        reader.readAsDataURL(file)
      })
      const result = await panelExtensionsApi.inspect(archive)
      const previousDigest = props.controller.entries().find(entry => entry.manifest.id === result.manifest.id)?.digest
      if (!disposed) setPreview({ ...result, source: { kind: "zip", archive }, previousDigest })
    })
  }
  const inspectCatalog = (entry: PanelExtensionCatalogEntry) => {
    setPreview(undefined); setAcknowledged(false)
    void run(async () => {
      const previousDigest = props.controller.entries().find(value => value.manifest.id === entry.manifest.id)?.digest
      const result = await panelExtensionsApi.inspectCatalog(entry.manifest.id, entry.digest)
      if (!disposed) setPreview({ ...result, source: { kind: "catalog" }, previousDigest })
    })
  }
  return <section class="panel-extension-manager window-shell" aria-label={t("panelExtensions.title")} aria-busy={loading()}>
    <input ref={picker} type="file" accept=".zip" hidden disabled={busy()} onChange={event => {
      const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; void inspect(file)
    }} />
    <Show when={!preview()}><div class="panel-extension-search-row">
      <input type="search" class="panel-extension-search" aria-label={t("panelExtensions.catalog.search")} placeholder={t("panelExtensions.catalog.search")}
        value={query()} onInput={event => setQuery(event.currentTarget.value)} />
      <button type="button" class="window-icon-button" title={t("instanceShell.rightPanel.actions.refresh")} aria-label={t("instanceShell.rightPanel.actions.refresh")}
        disabled={loading() || busy()} onClick={() => { void load(true); void props.controller.refresh() }}>
        <RefreshCw class={loading() ? "animate-spin" : ""} />
      </button>
      <button class="window-icon-button panel-extension-zip" type="button" title={t("panelExtensions.install")} aria-label={t("panelExtensions.install")}
        disabled={busy() || !props.controller.verified()} onClick={() => picker.click()}><FileArchive /></button>
    </div></Show>
    <Show when={failed() || props.controller.failed()}>
      <p role="alert">{t("panelExtensions.error")}</p>
      <button type="button" class="window-action" disabled={busy()} onClick={() => void run(() => props.controller.refresh())}>
        {t("instanceShell.rightPanel.actions.refresh")}
      </button>
    </Show>
    <Show when={preview()} fallback={<>
      <Show when={catalogFailed()}><p role="alert">{t("panelExtensions.catalog.error")}</p></Show>
      <Show when={!loading() && !rows().length}><p class="panel-extension-empty" role="status">{t("panelExtensions.catalog.empty")}</p></Show>
      <For each={rows()}>{row => {
        const entry = row.installed, available = row.catalog, manifest = entry?.manifest ?? available!.manifest
        const installLabel = () => t(!available?.compatible ? "panelExtensions.catalog.incompatible" : entry ? "panelExtensions.catalog.replace" : "panelExtensions.catalog.install", { apiVersion: available?.manifest.apiVersion })
        return <div class="panel-extension-row" role="group" aria-label={manifest.name}>
          <ExtensionName name={manifest.name} version={manifest.version}
            details={`${available?.description ?? ""}\n${manifest.id}\n${manifest.author}\n${manifest.repository}\n${entry?.digest ?? available?.digest}`} />
          <div class="panel-extension-row-actions">
            <Show when={available && entry?.digest !== available.digest}>
              <button type="button" class="window-icon-button" title={installLabel()} aria-label={installLabel()}
                disabled={busy() || loading() || !available?.compatible || !props.controller.verified()}
                onClick={() => inspectCatalog(available!)}><Download /></button>
            </Show>
            <Show keyed when={entry}>{installed =>
              <button type="button" class="window-icon-button" title={t("panelExtensions.remove")} aria-label={t("panelExtensions.remove")} disabled={busy()}
                onClick={() => setRemoval({ id: installed.manifest.id, digest: installed.digest })}><Trash2 /></button>
            }</Show>
          </div>
          <Show when={entry && removal()?.id === entry.manifest.id && removal()?.digest === entry.digest}>
            <div class="panel-extension-removal">
              <p>{t("panelExtensions.removeWarning")}</p>
              <div class="panel-extension-actions">
                <button type="button" class="window-action" disabled={busy()} onClick={() => void run(async () => {
                  const pending = removal()
                  if (!pending) return
                  await panelExtensionsApi.remove(pending.id, pending.digest); if (!disposed) setRemoval(undefined)
                })}>{t("panelExtensions.removeConfirm")}</button>
                <button type="button" class="window-action" disabled={busy()} onClick={() => setRemoval(undefined)}>{t("panelExtensions.cancel")}</button>
              </div>
            </div>
          </Show>
        </div>
      }}</For>
    </>}>{pkg => <div class="panel-extension-review">
      <strong>{pkg().manifest.name} {pkg().manifest.version}</strong>
      <details>
        <summary>{pkg().manifest.author} · {pkg().manifest.license} · API {pkg().manifest.apiVersion}</summary>
        <p>{pkg().manifest.repository}</p>
        <code>{pkg().digest}</code>
      </details>
      <p>{t("panelExtensions.permission")}</p>
      <p>{t("panelExtensions.warning")}</p>
      <label><input type="checkbox" checked={acknowledged()} onChange={event => setAcknowledged(event.currentTarget.checked)} />{t("panelExtensions.trust")}</label>
      <div class="panel-extension-actions">
        <button type="button" class="window-action" disabled={busy() || !acknowledged()} onClick={() => void run(async () => {
          const selected = pkg(), source = selected.source
          if (source.kind === "zip") await panelExtensionsApi.install(source.archive, selected.digest, selected.previousDigest)
          else await panelExtensionsApi.installCatalog(selected.manifest.id, selected.digest, selected.previousDigest)
          if (!disposed) { setPreview(undefined); setQuery("") }
        })}>{t("panelExtensions.confirm")}</button>
        <button type="button" class="window-action" disabled={busy()} onClick={() => setPreview(undefined)}>{t("panelExtensions.cancel")}</button>
      </div>
    </div>}</Show>
  </section>
}
