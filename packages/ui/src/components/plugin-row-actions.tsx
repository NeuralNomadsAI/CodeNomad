import { For, Show, createEffect, createMemo, onCleanup } from "solid-js"
import { DropdownMenu } from "@kobalte/core/dropdown-menu"
import { Download, Link, MoreHorizontal, PackageSearch, RefreshCw, Trash2 } from "lucide-solid"
import type { PluginConfiguredSource, PluginControlLocation, PluginControlScope, PluginRuntimeSource } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { showToastNotification } from "../lib/notifications"
import { HttpResponseError } from "../lib/retryable-file-search"
import { isPluginPackagePending, runPluginPackageAction } from "../stores/plugin-package-actions"
import { pluginSourcesStore } from "../stores/plugin-sources"
import { showConfirmDialog } from "../stores/alerts"
import { serverEvents } from "../lib/server-events"

type RemovableSource = PluginConfiguredSource & { scope: PluginControlScope }
type Item =
  | { kind: "package"; action: "check" | "update"; target: string }
  | { kind: "remove"; source: RemovableSource }
  | { kind: "refresh" }
  | { kind: "attach" }
  | { kind: "installHost" }

export const PLUGIN_SOURCE_CONFIRM_DELAY_MS = 600
export const PLUGIN_SOURCE_CONFIRM_EXPIRY_MS = 120_000

/** One compact menu per Plugins row: the native package check/update, removal of each removable
 * declaration from its scope's own document, and Refresh for sources the inventory never confirmed. */
export function PluginRowActions(props: {
  instanceId: string
  location: PluginControlLocation
  name: string
  source?: PluginRuntimeSource
  removable: readonly RemovableSource[]
  refresh?: () => void
  active?: boolean
  consentEpoch?: number
  sessionId?: string
  attach?: () => void | Promise<void>
  installHost?: { action: "install" | "update"; run: () => void | Promise<void> }
}) {
  const { t } = useI18n()
  let attachAfterClose: (() => void | Promise<void>) | undefined
  let generation = 0
  let confirmation: AbortController | undefined
  let trigger: HTMLButtonElement | undefined
  let surface: HTMLElement | null | undefined
  let admittedOwner: string | undefined
  let disposed = false
  const presentationOwner = () => JSON.stringify([props.instanceId, props.location.directory, props.sessionId, props.active !== false])
  const restoreFocus = () => {
    if (trigger?.isConnected && !trigger.disabled) trigger.focus()
    else surface?.querySelector<HTMLButtonElement>("[data-plugin-refresh]")?.focus()
  }
  const cancel = () => confirmation?.abort()
  const ownership = createMemo(() => JSON.stringify([props.instanceId, props.location.directory,
    props.sessionId, props.source?.type === "package" ? props.source.target : null, props.active !== false,
    props.consentEpoch, props.removable]))
  createEffect(() => { ownership(); generation++; cancel() })
  onCleanup(serverEvents.onTransportStatus(status => { if (status === "disconnected") cancel() }))
  onCleanup(serverEvents.on("instance.eventStatus", event => { if (event.type === "instance.eventStatus" && event.instanceId === props.instanceId) cancel() }))
  onCleanup(() => {
    disposed = true; generation++; cancel()
    if (admittedOwner && (document.activeElement === trigger || document.activeElement === document.body)) queueMicrotask(() => {
      if (surface?.isConnected && presentationOwner() === admittedOwner && props.active !== false) surface.querySelector<HTMLButtonElement>("[data-plugin-refresh]")?.focus()
    })
  })
  const pkg = () => props.source?.type === "package" ? props.source : undefined
  const packageBusy = () => Boolean(pkg()?.updating || (pkg() && isPluginPackagePending(props.instanceId, pkg()!.target)))
  const removing = (source: RemovableSource) => pluginSourcesStore.isRemoving(props.instanceId, props.location, source)
  const busy = () => packageBusy() || props.removable.some(removing)
  const scopeLabel = (scope: PluginControlScope) => t(`instanceServiceStatus.plugins.scope.${scope}`)
  // Stable descriptors: icons are created by the item renderer, once per rendered item.
  const items = createMemo<Item[]>(() => [
    ...(pkg() ? [{ kind: "package" as const, action: pkg()!.outdated ? "update" as const : "check" as const, target: pkg()!.target }] : []),
    ...props.removable.filter(source => source.expectedRevision).map(source => ({ kind: "remove" as const, source })),
    ...(props.refresh ? [{ kind: "refresh" as const }] : []),
    ...(props.attach ? [{ kind: "attach" as const }] : []),
    ...(props.installHost ? [{ kind: "installHost" as const }] : []),
  ])
  const packageLabel = (item: Extract<Item, { kind: "package" }>) => t(`settings.pluginPackages.${item.action}`, { target: item.target })
  const label = (item: Item) => item.kind === "package" ? packageLabel(item)
    : item.kind === "remove" ? t("instanceServiceStatus.plugins.sources.remove", { scope: scopeLabel(item.source.scope) })
      : item.kind === "installHost" ? t(`integrations.installHost.${props.installHost?.action ?? "install"}`)
        : t(item.kind === "attach" ? "integrations.attach" : "instanceServiceStatus.plugins.refresh")
  const hint = (item: Item) => item.kind === "package" ? t("settings.pluginPackages.shared")
    : item.kind === "remove" ? `${item.source.target}\n${item.source.path ?? ""}` : undefined
  const triggerLabel = () => {
    const only = items().length === 1 ? items()[0] : undefined
    return only?.kind === "package" ? packageLabel(only) : t("instanceServiceStatus.plugins.sources.actions", { name: props.name })
  }

  const runPackage = (item: Extract<Item, { kind: "package" }>) => {
    if (packageBusy() || props.active === false) return
    const owner = presentationOwner()
    void runPluginPackageAction(props.instanceId, { ...props.location }, item.target, item.action).catch(() => {
      if (!disposed && owner === presentationOwner()) showToastNotification({ category: "opencode", variant: "error", message: t("settings.pluginPackages.error", { target: item.target }) })
    })
  }
  const runRemove = async (source: RemovableSource) => {
    if (removing(source) || confirmation || props.active === false || !source.expectedRevision) return
    const captured = generation
    const instanceId = props.instanceId, location = { ...props.location }, selected = { ...source }
    const owner = ownership()
    const feedbackOwner = presentationOwner()
    surface = trigger?.closest<HTMLElement>(".plugin-controls")
    confirmation = new AbortController()
    const signal = confirmation.signal
    const action = t("instanceServiceStatus.plugins.sources.remove", { scope: scopeLabel(source.scope) })
    const accepted = await showConfirmDialog(t("instanceServiceStatus.plugins.sources.removeWarning"), {
      title: `${action} — ⁨${props.name}⁩`,
      detail: `${source.target}\n${source.scope === "global" ? t("instanceServiceStatus.plugins.sources.removeGlobalWarning") + "\n" : ""}${t("instanceServiceStatus.plugins.sources.removeRecovery")}`,
      confirmLabel: action, variant: "warning", confirmDelayMs: PLUGIN_SOURCE_CONFIRM_DELAY_MS,
      expiresAfterMs: PLUGIN_SOURCE_CONFIRM_EXPIRY_MS, returnFocus: () => { if (presentationOwner() === feedbackOwner) restoreFocus() },
    }, signal)
    confirmation = undefined
    if (!accepted || signal.aborted || captured !== generation || ownership() !== owner) return
    admittedOwner = feedbackOwner
    void pluginSourcesStore.remove(instanceId, location, selected).catch(error => {
      if (!surface?.isConnected || presentationOwner() !== feedbackOwner) return
      const stale = error instanceof HttpResponseError && error.status === 409
      showToastNotification({ category: "opencode", variant: "error", message: t(stale
        ? "instanceServiceStatus.plugins.sources.errors.removeStale"
        : "instanceServiceStatus.plugins.sources.errors.remove", { name: source.target, scope: scopeLabel(source.scope) }) })
    })
  }
  const run = (item: Item) => item.kind === "package" ? runPackage(item) : item.kind === "remove" ? (attachAfterClose = () => runRemove(item.source))
    : item.kind === "attach" ? (attachAfterClose = props.attach)
      : item.kind === "installHost" ? (attachAfterClose = props.installHost?.run) : props.refresh?.()

  const icon = (item: Item, pulse = false) => item.kind === "package"
    ? (item.action === "update"
      ? <Download class="h-3.5 w-3.5" classList={{ "animate-pulse": pulse }} aria-hidden="true" />
      : <PackageSearch class="h-3.5 w-3.5" classList={{ "animate-pulse": pulse }} aria-hidden="true" />)
    : item.kind === "remove" ? <Trash2 class="h-3.5 w-3.5" aria-hidden="true" />
      : item.kind === "installHost" ? <Download class="h-3.5 w-3.5" aria-hidden="true" />
      : item.kind === "attach" ? <Link class="h-3.5 w-3.5" aria-hidden="true" /> : <RefreshCw class="h-3.5 w-3.5" aria-hidden="true" />

  return <Show when={items().length > 0}>
    <DropdownMenu placement="bottom-end" gutter={4}>
      <DropdownMenu.Trigger type="button" class="icon-button-compact" disabled={busy() || props.active === false}
        ref={trigger}
        title={items().length === 1 ? [label(items()[0]!), hint(items()[0]!)].filter(Boolean).join("\n") : triggerLabel()}
        aria-label={triggerLabel()} aria-busy={busy()}>
        <Show when={items()[0]?.kind === "package"} fallback={<MoreHorizontal class="h-3.5 w-3.5" classList={{ "animate-pulse": busy() }} aria-hidden="true" />}>
          {icon(items()[0]!, busy())}
        </Show>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="action-overflow-content" onCloseAutoFocus={() => {
          const action = attachAfterClose; attachAfterClose = undefined
          if (action) queueMicrotask(() => void action())
        }}>
          <For each={items()}>{item => (
            <DropdownMenu.Item class="action-overflow-item" disabled={busy() || props.active === false}
              title={hint(item)} onSelect={() => run(item)}>
              <span class="action-overflow-item-icon" aria-hidden="true">{icon(item)}</span>
              <span class="action-overflow-item-label">{label(item)}</span>
            </DropdownMenu.Item>
          )}</For>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  </Show>
}
