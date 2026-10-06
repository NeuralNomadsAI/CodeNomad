import { For, Show, createEffect, createSignal, type Accessor } from "solid-js"
import type { PanelExtensionManifest, PanelExtensionCatalogEntry } from "../../../../server/src/api-types"
import { PANEL_EXTENSION_LIMITS } from "../../../../server/src/panel-extensions/contract"
import { panelExtensionsApi } from "../../lib/panel-extensions-api"
import { useI18n } from "../../lib/i18n"
import type { PanelExtensionsController } from "./use-panel-extensions"
import { ExtensionCatalog } from "./extension-catalog"

export function ExtensionManager(props: { instanceId: Accessor<string>; controller: PanelExtensionsController }) {
  const { t } = useI18n()
  const [busy, setBusy] = createSignal(false), [failed, setFailed] = createSignal(false), [acknowledged, setAcknowledged] = createSignal(false)
  const [preview, setPreview] = createSignal<{ manifest: PanelExtensionManifest; digest: string;
    source: { kind: "zip"; archive: string } | { kind: "catalog" }; previousDigest?: string }>()
  const [removal, setRemoval] = createSignal<{ id: string; digest: string }>()
  createEffect(() => {
    const pending = removal()
    if (pending && !props.controller.entries().some(entry => entry.manifest.id === pending.id && entry.digest === pending.digest)) setRemoval(undefined)
  })
  let picker!: HTMLInputElement
  const run = async (operation: () => Promise<unknown>) => {
    if (busy()) return
    setBusy(true); setFailed(false)
    try { await operation(); await props.controller.refresh() } catch { setFailed(true) }
    finally { setBusy(false) }
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
      setPreview({ ...result, source: { kind: "zip", archive }, previousDigest })
    })
  }
  const inspectCatalog = (entry: PanelExtensionCatalogEntry) => {
    setPreview(undefined); setAcknowledged(false)
    void run(async () => {
      const previousDigest = props.controller.entries().find(value => value.manifest.id === entry.manifest.id)?.digest
      const result = await panelExtensionsApi.inspectCatalog(entry.manifest.id, entry.digest)
      setPreview({ ...result, source: { kind: "catalog" }, previousDigest })
    })
  }
  return <section class="panel-extension-manager" aria-label={t("panelExtensions.title")}>
    <h3>{t("panelExtensions.title")}</h3>
    <input ref={picker} type="file" accept=".zip" hidden disabled={busy()} onChange={event => {
      const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; void inspect(file)
    }} />
    <button class="right-panel-customization-button" type="button" disabled={busy() || !props.controller.verified()} onClick={() => picker.click()}>{t("panelExtensions.install")}</button>
    <Show when={failed() || props.controller.failed()}>
      <p role="alert">{t("panelExtensions.error")}</p>
      <button type="button" class="right-panel-customization-button" disabled={busy()} onClick={() => void run(() => props.controller.refresh())}>
        {t("instanceShell.rightPanel.actions.refresh")}
      </button>
    </Show>
    <Show when={preview()}>{pkg => <div class="panel-extension-review">
      <strong>{pkg().manifest.name} {pkg().manifest.version}</strong>
      <p>{pkg().manifest.author} · {pkg().manifest.license} · API {pkg().manifest.apiVersion}</p>
      <p>{pkg().manifest.repository}</p>
      <code>{pkg().digest}</code>
      <p>{t("panelExtensions.permission")}</p>
      <p>{t("panelExtensions.warning")}</p>
      <label><input type="checkbox" checked={acknowledged()} onChange={event => setAcknowledged(event.currentTarget.checked)} />{t("panelExtensions.trust")}</label>
      <div class="panel-extension-actions">
        <button type="button" class="right-panel-customization-button" disabled={busy() || !acknowledged()} onClick={() => void run(async () => {
          const selected = pkg(), source = selected.source
          if (source.kind === "zip") await panelExtensionsApi.install(source.archive, selected.digest, selected.previousDigest)
          else await panelExtensionsApi.installCatalog(selected.manifest.id, selected.digest, selected.previousDigest)
          setPreview(undefined)
        })}>{t("panelExtensions.confirm")}</button>
        <button type="button" class="right-panel-customization-button" disabled={busy()} onClick={() => setPreview(undefined)}>{t("panelExtensions.cancel")}</button>
      </div>
    </div>}</Show>
    <ExtensionCatalog installed={props.controller.entries} busy={busy} verified={props.controller.verified} inspect={inspectCatalog} />
    <h3>{t("panelExtensions.catalog.installedTitle")}</h3>
    <For each={props.controller.entries()}>{entry => <div class="panel-extension-row" role="group" aria-label={entry.manifest.name}>
      <span title={`${entry.manifest.id}\n${entry.manifest.author}\n${entry.manifest.repository}\n${entry.digest}`}>{entry.manifest.name} {entry.manifest.version}</span>
      <div class="panel-extension-actions">
        <label><input type="checkbox" checked={entry.global} disabled={busy() || !props.controller.verified()} onChange={event => {
          const enabled = event.currentTarget.checked
          void run(() => panelExtensionsApi.activate(props.instanceId(), entry.manifest.id, entry.digest, "global", enabled))
        }} />{t("panelExtensions.global")}</label>
        <label><input type="checkbox" checked={entry.project} disabled={busy() || entry.global || !props.controller.verified()} onChange={event => {
          const enabled = event.currentTarget.checked
          void run(() => panelExtensionsApi.activate(props.instanceId(), entry.manifest.id, entry.digest, "project", enabled))
        }} />{t("panelExtensions.project")}</label>
        <button type="button" class="right-panel-customization-button" disabled={busy()} onClick={() => setRemoval({ id: entry.manifest.id, digest: entry.digest })}>{t("panelExtensions.remove")}</button>
      </div>
      <Show when={removal()?.id === entry.manifest.id && removal()?.digest === entry.digest}>
        <p>{t("panelExtensions.removeWarning")}</p>
        <button type="button" class="right-panel-customization-button" disabled={busy()} onClick={() => void run(async () => {
          const pending = removal()
          if (!pending) return
          await panelExtensionsApi.remove(pending.id, pending.digest); setRemoval(undefined)
        })}>{t("panelExtensions.removeConfirm")}</button>
        <button type="button" class="right-panel-customization-button" disabled={busy()} onClick={() => setRemoval(undefined)}>{t("panelExtensions.cancel")}</button>
      </Show>
    </div>}</For>
  </section>
}
