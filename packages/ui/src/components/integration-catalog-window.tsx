import { Dialog } from "@kobalte/core/dialog"
import { For, Show, createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
import { BookOpen, RefreshCw } from "lucide-solid"
import type { PluginControlLocation, PluginControlScope } from "../../../server/src/api-types"
import type { IntegrationView } from "../../../server/src/integration-types"
import { openExternalUrl } from "../lib/external-url"
import { captureBackendOperation } from "../lib/backend-operation"
import { useI18n } from "../lib/i18n"
import { showToastNotification } from "../lib/notifications"
import { integrationEpoch, integrations } from "../stores/integrations"
import { pluginSourcesStore } from "../stores/plugin-sources"
import { InfoPopoverButton } from "./info-popover-button"
import { confirmIntegrationAction } from "./integration-confirmation"
import { integrationSummary } from "../lib/integration-row-state"
import WindowCloseButton from "./window-close-button"

/** Catalogue entries that can be installed here: neither declared nor loaded, and not ambiguous. */
export function installableIntegrations(entries: readonly IntegrationView[]): IntegrationView[] {
  return entries.filter(entry => !entry.ambiguous && !entry.plugin.declared && entry.plugin.runtime === undefined)
}

/**
 * "Add an integration…": one row per installable catalogue entry, in catalogue order. Install confirms, closes the
 * window and installs by catalogue ID; the integration's Status section then shows the installation.
 */
export function IntegrationCatalogWindow(props: {
  instanceId: string
  location: PluginControlLocation
  projectAvailable: boolean
  active?: boolean
  sessionId?: string
  open: boolean
  onClose: () => void
  /** The "+" trigger, focused again on close when it is still shown. */
  trigger: () => HTMLElement | undefined
}) {
  const { t, locale } = useI18n()
  const state = createMemo(() => integrations.state(props.instanceId, props.location.directory))
  const response = () => { const value = state(); return value.status === "ready" ? value.response : undefined }
  const catalog = () => response()?.catalog
  const rows = createMemo(() => installableIntegrations(response()?.integrations ?? []))
  const unavailable = () => state().status === "error" || catalog()?.state === "unavailable"
  const scopeLabel = (scope: PluginControlScope) => t(`instanceServiceStatus.plugins.scope.${scope}`)
  const date = () => {
    const value = catalog()?.fetchedAt
    return value ? new Intl.DateTimeFormat(locale(), { dateStyle: "medium" }).format(new Date(value)) : ""
  }
  const refresh = () => void integrations.refreshDemanded(props.instanceId)
  const focusTrigger = () => {
    const trigger = props.trigger()
    if (trigger?.isConnected && trigger.getClientRects().length) trigger.focus()
    else document.querySelector<HTMLElement>('[data-status-section-trigger="plugins"]')?.focus()
  }

  const active = () => props.active !== false
  const identity = createMemo(() => JSON.stringify([props.instanceId, props.location.directory, props.sessionId, active(), props.open,
    integrationEpoch(props.instanceId, props.sessionId)]))
  let confirmation: AbortController | undefined
  createEffect(() => { identity(); confirmation?.abort() })
  onCleanup(() => confirmation?.abort())
  const install = async (entry: IntegrationView, scope: PluginControlScope) => {
    if (!active() || confirmation) return
    const instanceId = props.instanceId, location = { directory: props.location.directory }
    const owner = identity()
    confirmation = new AbortController()
    const operation = captureBackendOperation(instanceId, confirmation.signal)
    const signal = operation.signal
    if (!operation.current()) { confirmation = undefined; return }
    const accepted = await confirmIntegrationAction(t("integrations.install.confirm", { name: entry.displayName, scope: scopeLabel(scope) }), {
      title: t("integrations.install.title"), confirmLabel: t("integrations.catalog.install"), variant: "warning",
      ...(scope === "project" ? { detail: t("instanceServiceStatus.plugins.sources.projectWarning") } : {}),
      returnFocus: () => { if (operation.current()) focusTrigger() },
    }, signal)
    confirmation = undefined
    if (!accepted || !operation.current() || identity() !== owner) return
    props.onClose()
    try {
      // Sent once: a lost answer is reconciled by the next read, never replayed.
      await pluginSourcesStore.installIntegration(instanceId, location, entry.id, scope)
      if (!operation.current()) return
      showToastNotification({ category: "opencode", variant: "info", message: t("integrations.message.installRequested") })
    } catch {
      if (!operation.current()) return
      showToastNotification({ category: "opencode", variant: "error", message: t("integrations.install.error") })
    }
  }

  return <Show when={props.open}>
    <Dialog open modal onOpenChange={next => { if (!next) props.onClose() }}>
      <Dialog.Portal><Dialog.Overlay class="modal-overlay z-[1300]" />
        <Dialog.Content role="dialog" class="window-shell integration-catalog" onCloseAutoFocus={event => { event.preventDefault(); focusTrigger() }}>
          <header class="window-header">
            <Dialog.Title class="window-title">{t("integrations.catalog.title")}</Dialog.Title>
            <WindowCloseButton onClose={props.onClose} />
          </header>
          <div class="window-body integration-catalog-body">
            <Show when={unavailable()}>
              <p class="integration-catalog-state" role="status">
                {t("integrations.catalogUnavailable")}
                <button type="button" class="icon-button-compact" aria-label={t("integrations.refresh")} title={t("integrations.refresh")} onClick={refresh}>
                  <RefreshCw class="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </p>
            </Show>
            <Show when={!unavailable() && catalog()?.state === "stale"}>
              <p class="integration-catalog-state" role="status">{t("integrations.catalogStale", { date: date() })}</p>
            </Show>
            <Show when={!unavailable() && response()}>
              <Show when={rows().length > 0} fallback={<p class="integration-catalog-state">{t("integrations.catalog.allInstalled")}</p>}>
                <ul class="integration-catalog-list">
                  <For each={rows()}>{entry => <IntegrationCatalogRow t={t} entry={entry} summary={() => integrationSummary(entry, locale())}
                    projectAvailable={props.projectAvailable} disabled={props.active === false} onInstall={scope => void install(entry, scope)} />}</For>
                </ul>
              </Show>
            </Show>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  </Show>
}

function IntegrationCatalogRow(props: {
  t: (key: string, vars?: Record<string, any>) => string
  entry: IntegrationView
  summary: Accessor<string>
  projectAvailable: boolean
  disabled: boolean
  onInstall: (scope: PluginControlScope) => void
}) {
  const t = props.t
  const [scope, setScope] = createSignal<PluginControlScope>("global")
  // D18: a native integration installs in Global only; its scope selector stays focusable to show why.
  const globalOnly = () => props.entry.family === "native"
  const scopeLabel = (value: PluginControlScope) => t(`instanceServiceStatus.plugins.scope.${value}`)
  return <li class="integration-catalog-row" data-catalog-integration={props.entry.id}>
    <span class="integration-catalog-name"><bdi>{props.entry.displayName}</bdi></span>
    <span class="integration-state-badge badge-shape" data-integration-family={props.entry.family}>{t(`integrations.catalog.family.${props.entry.family}`)}</span>
    <InfoPopoverButton label={t("integrations.info", { name: props.entry.displayName })}><p>{props.summary()}</p></InfoPopoverButton>
    <Show when={props.entry.docs}>{docs => (
      <button type="button" class="section-info-trigger" aria-label={t("integrations.docs")} title={t("integrations.docs")}
        onClick={() => void openExternalUrl(docs(), "integration-docs")}><BookOpen class="section-info-icon" aria-hidden="true" /></button>
    )}</Show>
    <select class="integration-catalog-scope" aria-label={`${t("integrations.catalog.scope")} — ${props.entry.displayName}`}
      value={globalOnly() ? "global" : scope()} aria-disabled={globalOnly() ? "true" : undefined}
      title={globalOnly() ? t("integrations.section.scopeGlobalOnly") : undefined}
      onMouseDown={event => { if (globalOnly()) event.preventDefault() }}
      onKeyDown={event => { if (globalOnly() && event.key !== "Tab" && event.key !== "Escape") event.preventDefault() }}
      onChange={event => { if (globalOnly()) event.currentTarget.value = "global"; else setScope(event.currentTarget.value as PluginControlScope) }}>
      <option value="global">{scopeLabel("global")}</option>
      <option value="project" disabled={!props.projectAvailable || globalOnly()}>{scopeLabel("project")}</option>
    </select>
    <button type="button" class="window-text-button" disabled={props.disabled}
      aria-label={`${t("integrations.catalog.install")} — ${props.entry.displayName}`}
      onClick={() => props.onInstall(globalOnly() ? "global" : scope())}>{t("integrations.catalog.install")}</button>
  </li>
}
