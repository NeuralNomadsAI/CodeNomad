import { For, Show, createMemo, createSignal, createUniqueId, onCleanup } from "solid-js"
import type { PluginActivationControl, PluginConfigScope, PluginControlLocation, PluginControlScope, PluginControlsSnapshot, PluginRuntimeInventoryEntry } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { pluginControlsCache } from "../stores/plugin-controls"
import { InfoPopoverButton } from "./info-popover-button"

const VALUE_PLACEHOLDER = "\ufffc"
const isolatedValue = (text: string, value: string) => text.split(VALUE_PLACEHOLDER)
  .flatMap((part, index) => index ? [<bdi>{value}</bdi>, part] : [part])

interface AttentionEntry {
  key: string
  name: string
  control?: PluginActivationControl
  runtime?: PluginRuntimeInventoryEntry
}

export function PluginSystemAttention(props: {
  instanceId: string
  location: PluginControlLocation
  snapshot?: PluginControlsSnapshot
  runtimeUnconfirmed?: ReadonlySet<string>
  active?: boolean
  restoreFocus: () => void
}) {
  const { t } = useI18n()
  const headingId = `plugin-system-attention-${createUniqueId()}`
  const entries = createMemo(() => {
    const result = new Map<string, AttentionEntry>()
    const represented = new Set<string>()
    const representedRuntimeKeys = new Set<string>()
    for (const control of props.snapshot?.controls ?? []) {
      if (control.managedBy !== "codenomad") continue
      if (control.runtime?.source.type === "package") represented.add(control.runtime.source.target)
      if (control.runtime?.source.type === "local") represented.add(control.runtime.source.path)
      if (control.runtime) representedRuntimeKeys.add(control.runtime.key)
      result.set(`id:${control.id}`, { key: `id:${control.id}`, name: control.id, control, runtime: control.runtime })
    }
    for (const runtime of props.snapshot?.runtime ?? []) {
      if (runtime.managedBy !== "codenomad") continue
      if (representedRuntimeKeys.has(runtime.key)) continue
      const name = runtime.id ?? (runtime.source.type === "package" ? runtime.source.target : runtime.source.type === "local" ? runtime.source.path : runtime.key)
      const key = runtime.id ? `id:${runtime.id}` : `target:${name}`
      if (runtime.source.type === "package") represented.add(runtime.source.target)
      if (runtime.source.type === "local") represented.add(runtime.source.path)
      if (!result.has(key)) result.set(key, { key, name, runtime })
    }
    for (const source of props.snapshot?.configured.sources ?? []) {
      if (source.managedBy !== "codenomad" || represented.has(source.target) || (source.pluginId && result.has(`id:${source.pluginId}`))) continue
      const key = `target:${source.target}`
      result.set(key, { key, name: source.pluginId ?? source.target })
    }
    return new Map([...result].filter(([, entry]) => entry.control?.effective === "disabled" || entry.runtime?.state.status !== "active" || props.runtimeUnconfirmed?.has(entry.name)))
  })
  const keys = createMemo(() => [...entries().keys()])
  const renderEntry = (key: string) => {
    const entry = () => entries().get(key)
    const [pending, setPending] = createSignal(false)
    const [mutationScope, setMutationScope] = createSignal<PluginControlScope>()
    const [error, setError] = createSignal<string>()
    let row: HTMLDivElement | undefined
    let disposed = false
    const restoreFocus = () => {
      if (props.active === false) return
      requestAnimationFrame(() => {
        if (props.active !== false && document.activeElement === document.body) props.restoreFocus()
      })
    }
    onCleanup(() => {
      disposed = true
      if (row?.contains(document.activeElement)) restoreFocus()
    })
    const disabled = () => entry()?.control?.effective === "disabled"
    const scope = (): PluginControlScope | undefined => {
      if (!disabled()) return
      const controlling = entry()?.control?.controllingRule?.scope
      const writable = (value: string | undefined) => props.snapshot?.targets.some(target => target.scope === value)
      if ((controlling === "global" || controlling === "project") && writable(controlling)) return controlling
      return writable("project") ? "project" : undefined
    }
    const scopeLabel = (value: string | undefined) => t(`instanceServiceStatus.plugins.scope.${value ?? "project"}`)
    const configurations = createMemo(() => {
      const current = entry(), runtime = current?.runtime?.source
      const target = runtime?.type === "package" ? runtime.target : runtime?.type === "local" ? runtime.path : undefined
      const sources = props.snapshot?.configured.sources.filter(source => source.managedBy === "codenomad" && (
        (source.pluginId && source.pluginId === current?.name) || source.target === target || `target:${source.target}` === key
      )) ?? []
      const rule = current?.control?.controllingRule
      const records: Array<{ scope: PluginConfigScope; path?: string }> = sources.map(source => ({ scope: source.scope, path: source.path ?? source.target }))
      if (rule) {
        const path = rule.path ?? props.snapshot?.targets.find(target => target.scope === rule.scope)?.path
        records.push({ scope: rule.scope, path })
      }
      if (!records.length) {
        const target = props.snapshot?.targets.find(target => target.scope === "global") ?? props.snapshot?.targets[0]
        if (target) records.push({ scope: target.scope, path: target.path })
      }
      return [...new Map(records.map(record => [JSON.stringify(record), record])).values()]
    })
    const shownScopes = () => [...new Set(configurations().map(record => scopeLabel(record.scope)))].join(" / ")
    const label = () => t(`instanceServiceStatus.plugins.system.${disabled() ? "disabled" : props.runtimeUnconfirmed?.has(entry()?.name ?? "") ? "unconfirmed" : entry()?.runtime?.state.status === "failed" ? "failed" : "unconfirmed"}`,
      { name: VALUE_PLACEHOLDER, scope: scopeLabel(entry()?.control?.controllingRule?.scope) })
    const failed = () => {
      const state = entry()?.runtime?.state
      return state?.status === "failed" ? state : undefined
    }
    const runtimeDetails = createMemo(() => {
      const source = entry()?.runtime?.source
      return source?.type === "local" || source?.type === "package"
        ? isolatedValue(t(`instanceServiceStatus.plugins.source.${source.type}`, { source: VALUE_PLACEHOLDER }), source.type === "local" ? source.path : source.target)
        : undefined
    })
    const Details = () => {
      let container: HTMLDivElement | undefined
      onCleanup(() => {
        if (!entries().has(key) && container?.closest(".info-popover-content")?.contains(document.activeElement)) restoreFocus()
      })
      return <div ref={container} class="plugin-system-attention-details">
        <div><bdi>{entry()?.name}</bdi></div>
        <Show when={runtimeDetails()}>{value => <div>{value()}</div>}</Show>
        <For each={configurations()}>{record => <div>{scopeLabel(record.scope)}<Show when={record.path}>{path => <> — <bdi>{path()}</bdi></>}</Show></div>}</For>
        <Show when={failed()}>{failure => <>
          <div><bdi>{failure().error}</bdi></div>
          <Show when={failure().ref}>{ref => <div>{isolatedValue(t("instanceServiceStatus.plugins.sources.failureRef", { ref: VALUE_PLACEHOLDER }), ref())}</div>}</Show>
        </>}</Show>
      </div>
    }
    const active = () => props.active !== false
    const reenable = async () => {
      const current = entry(), targetScope = scope()
      if (!current?.control || !targetScope || pending() || !active()) return
      const instanceId = props.instanceId, location = { directory: props.location.directory }
      setMutationScope(targetScope)
      setPending(true)
      setError(undefined)
      try {
        await pluginControlsCache.mutate(instanceId, location, current.control.id, targetScope, true)
      } catch {
        if (!disposed && active() && props.instanceId === instanceId && props.location.directory === location.directory) {
          setError(t("instanceServiceStatus.plugins.errors.save", { name: current.name, scope: scopeLabel(targetScope) }))
        }
      } finally {
        if (!disposed) setPending(false)
      }
    }
    const renderAction = () => {
      let button: HTMLButtonElement | undefined
      onCleanup(() => { if (button === document.activeElement) restoreFocus() })
      return <button ref={button} type="button" class="window-text-button" aria-busy={pending()} aria-disabled={pending()}
        aria-label={t("instanceServiceStatus.plugins.system.reenableAriaLabel", { name: entry()?.name ?? "", scope: scopeLabel(scope() ?? mutationScope()) })}
        onClick={() => void reenable()}>
        {t(pending() ? "instanceServiceStatus.plugins.system.reenabling" : "instanceServiceStatus.plugins.system.reenable")}
      </button>
    }
    return <div ref={row} class="plugin-system-attention-entry" data-system-plugin={key}>
      <div class="plugin-system-attention-row">
        <span class="plugin-system-attention-label">{isolatedValue(label(), entry()?.name ?? "")}</span>
        <Show when={!disabled() || (scope() && scope() !== entry()?.control?.controllingRule?.scope)}>
          <span class="plugin-system-attention-scope">{disabled() ? scopeLabel(scope()) : shownScopes()}</span>
        </Show>
        <InfoPopoverButton label={t("instanceServiceStatus.plugins.system.details", { name: entry()?.name ?? "" })}>
          <Details />
        </InfoPopoverButton>
        <Show when={scope() || pending()}>{(_scope) => renderAction()}</Show>
      </div>
      <Show when={error()}><span role="alert">{error()}</span></Show>
    </div>
  }
  return <Show when={keys().length > 0}>
    <div class="plugin-system-attention" role="status" aria-live="polite" aria-labelledby={headingId}>
      <div id={headingId} class="plugin-system-attention-heading">{t("instanceServiceStatus.plugins.system.attention")}</div>
      <For each={keys()}>{renderEntry}</For>
    </div>
  </Show>
}
