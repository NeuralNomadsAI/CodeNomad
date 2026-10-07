import { For, Show, createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import { FileArchive, Trash2 } from "lucide-solid"
import type { PanelExtensionManifest, PanelExtensionCatalogEntry } from "../../../../server/src/api-types"
import { PANEL_EXTENSION_LIMITS } from "../../../../server/src/panel-extensions/contract"
import { panelExtensionsApi } from "../../lib/panel-extensions-api"
import { useI18n } from "../../lib/i18n"
import type { PanelExtensionsController } from "./use-panel-extensions"
import { ExtensionCatalog } from "./extension-catalog"
import { ExtensionName } from "./extension-name"

export function ExtensionManager(props: { instanceId: Accessor<string>; controller: PanelExtensionsController }) {
  const { t } = useI18n()
  const [busy, setBusy] = createSignal(false), [failed, setFailed] = createSignal(false), [acknowledged, setAcknowledged] = createSignal(false)
  const [preview, setPreview] = createSignal<{ manifest: PanelExtensionManifest; digest: string;
    source: { kind: "zip"; archive: string } | { kind: "catalog" }; previousDigest?: string }>()
  const [removal, setRemoval] = createSignal<{ id: string; digest: string }>()
  const [online, setOnline] = createSignal(!props.controller.entries().length)
  let disposed = false
  onCleanup(() => { disposed = true })
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
  return <section class="panel-extension-manager" aria-label={t("panelExtensions.title")}>
    <input ref={picker} type="file" accept=".zip" hidden disabled={busy()} onChange={event => {
      const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; void inspect(file)
    }} />
    <Show when={!preview()}><div class="window-toolbar">
      <button class="window-action" type="button" aria-pressed={!online()} disabled={busy()} onClick={() => setOnline(false)}>{t("panelExtensions.catalog.installedTitle")}</button>
      <button class="window-action" type="button" aria-pressed={online()} disabled={busy()} onClick={() => setOnline(true)}>{t("panelExtensions.catalog.title")}</button>
      <button class="window-icon-button panel-extension-zip" type="button" title={t("panelExtensions.install")} aria-label={t("panelExtensions.install")}
        disabled={busy() || !props.controller.verified()} onClick={() => picker.click()}><FileArchive /></button>
    </div></Show>
    <div class="window-body">
    <Show when={failed() || props.controller.failed()}>
      <p role="alert">{t("panelExtensions.error")}</p>
      <button type="button" class="window-action" disabled={busy()} onClick={() => void run(() => props.controller.refresh())}>
        {t("instanceShell.rightPanel.actions.refresh")}
      </button>
    </Show>
    <Show when={preview()} fallback={<>
      <Show when={online()} fallback={
        <div class="panel-extension-installed">
          <Show when={props.controller.entries().length} fallback={<p class="panel-extension-empty">{t("panelExtensions.empty")}</p>}>
            <div class="panel-extension-installed-header">
              <span /> <span>{t("panelExtensions.global")}</span><span>{t("panelExtensions.project")}</span><span />
            </div>
          </Show>
          <For each={props.controller.entries()}>{entry => <div class="panel-extension-installed-row" role="group" aria-label={entry.manifest.name}>
            <ExtensionName name={entry.manifest.name} version={entry.manifest.version}
              details={`${entry.manifest.id}\n${entry.manifest.author}\n${entry.manifest.repository}\n${entry.digest}`} />
            <input type="checkbox" aria-label={t("panelExtensions.global")} checked={entry.global} disabled={busy() || !props.controller.verified()}
              onChange={event => { const enabled = event.currentTarget.checked; void run(() => panelExtensionsApi.activate(props.instanceId(), entry.manifest.id, entry.digest, "global", enabled)) }} />
            <input type="checkbox" aria-label={t("panelExtensions.project")} checked={entry.project} disabled={busy() || entry.global || !props.controller.verified()}
              onChange={event => { const enabled = event.currentTarget.checked; void run(() => panelExtensionsApi.activate(props.instanceId(), entry.manifest.id, entry.digest, "project", enabled)) }} />
            <button type="button" class="window-icon-button" title={t("panelExtensions.remove")} aria-label={t("panelExtensions.remove")} disabled={busy()}
              onClick={() => setRemoval({ id: entry.manifest.id, digest: entry.digest })}><Trash2 /></button>
            <Show when={removal()?.id === entry.manifest.id && removal()?.digest === entry.digest}>
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
          </div>}</For>
        </div>
      }>
        <ExtensionCatalog installed={props.controller.entries} busy={busy} verified={props.controller.verified} inspect={inspectCatalog} />
      </Show>
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
          if (!disposed) { setPreview(undefined); setOnline(false) }
        })}>{t("panelExtensions.confirm")}</button>
        <button type="button" class="window-action" disabled={busy()} onClick={() => setPreview(undefined)}>{t("panelExtensions.cancel")}</button>
      </div>
    </div>}</Show>
    </div>
  </section>
}
