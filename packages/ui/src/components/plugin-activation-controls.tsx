import { For, Show, createEffect, createMemo, createSignal, createUniqueId, type Component } from "solid-js"
import { RefreshCw } from "lucide-solid"
import type {
  PluginActivationControl,
  PluginConfigScope,
  PluginControlLocation,
  PluginControlScope,
  PluginRuntimeInventoryEntry,
  PluginRuntimeSource,
  PluginScopeRuleState,
} from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { getLogger } from "../lib/logger"
import { showToastNotification } from "../lib/notifications"
import { HttpResponseError } from "../lib/retryable-file-search"
import { pluginControlsCache } from "../stores/plugin-controls"
import "../stores/plugin-controls-events"

interface PluginActivationControlsProps {
  instanceId: string
  location: PluginControlLocation
  showHeading?: boolean
}

const log = getLogger("session")

export const PluginActivationControls: Component<PluginActivationControlsProps> = (props) => {
  const { t } = useI18n()
  const [scope, setScope] = createSignal<PluginControlScope | null>(null)
  const [pending, setPending] = createSignal<Set<string>>(new Set())
  const headingId = `plugin-controls-${createUniqueId()}`
  const state = createMemo(() => pluginControlsCache.state(props.instanceId, props.location))
  const snapshot = createMemo(() => state().snapshot)
  const controls = createMemo(() => snapshot()?.controls ?? [])
  const runtime = createMemo(() => snapshot()?.runtime ?? [])
  const configuredOnly = createMemo(() => controls().filter((control) => !control.runtime))
  const selectedTarget = createMemo(() => snapshot()?.targets.find((target) => target.scope === scope()))
  let loadedIdentity: string | undefined
  let locationGeneration = 0

  createEffect(() => {
    const instanceId = props.instanceId
    const location = { ...props.location }
    const identity = JSON.stringify([instanceId, location.directory, location.workspaceID])
    if (loadedIdentity !== identity) {
      loadedIdentity = identity
      locationGeneration += 1
      setScope(null)
      setPending(new Set<string>())
    }
    void pluginControlsCache.load(instanceId, location)
  })

  const setPendingPlugin = (pluginId: string, value: boolean) => {
    setPending((previous) => {
      const next = new Set(previous)
      if (value) next.add(pluginId)
      else next.delete(pluginId)
      return next
    })
  }

  const toggle = async (control: PluginActivationControl, enabled: boolean) => {
    const selectedScope = scope()
    if (!selectedScope || pending().has(control.id)) return
    const requestGeneration = locationGeneration
    setPendingPlugin(control.id, true)
    try {
      const response = await pluginControlsCache.mutate(props.instanceId, props.location, control.id, selectedScope, enabled)
      if (requestGeneration !== locationGeneration) return
      showToastNotification({
        variant: "success",
        message: t(response.changed
          ? "instanceServiceStatus.plugins.toast.ruleSaved"
          : "instanceServiceStatus.plugins.toast.ruleUnchanged", {
          name: control.id,
          scope: scopeLabel(selectedScope),
        }),
      })
    } catch (error) {
      log.error("Failed to update plugin activation rule", { pluginId: control.id, scope: selectedScope, error })
      if (requestGeneration === locationGeneration) {
        showToastNotification({ variant: "error", message: t(errorMessageKey(error)) })
      }
    } finally {
      if (requestGeneration === locationGeneration) setPendingPlugin(control.id, false)
    }
  }

  const renderControl = (control: PluginActivationControl, runtimeEntry?: PluginRuntimeInventoryEntry) => {
    const selectedState = () => scope() ? control[scope()!] : control.effective
    const checked = () => selectedState() === "default" ? control.effective !== "disabled" : selectedState() === "enabled"
    const isPending = () => pending().has(control.id)
    const overridden = () => Boolean(
      scope() === "global"
      && control.controllingRule?.scope === "project"
      && control.global !== control.effective,
    )
    return (
      <article class="plugin-control-card" data-plugin-id={control.id}>
        <div class="plugin-control-card-main">
          <div class="plugin-control-identity">
            <div class="plugin-control-name">{control.id}</div>
            <div class="plugin-control-meta">
              <span class={`badge-shape plugin-status-badge plugin-status-${runtimeStatus(runtimeEntry)}`}>
                {t(`instanceServiceStatus.plugins.runtime.${runtimeStatus(runtimeEntry)}`)}
              </span>
              <span class="badge-shape plugin-rule-badge">
                {t(`instanceServiceStatus.plugins.ruleState.${control.effective}`)}
              </span>
            </div>
          </div>
          <button
            type="button"
            role="switch"
            class="plugin-activation-switch"
            classList={{ "plugin-activation-switch-checked": checked(), "plugin-activation-switch-pending": isPending() }}
            aria-checked={checked()}
            aria-label={t("instanceServiceStatus.plugins.toggleAriaLabel", { name: control.id })}
            disabled={!scope() || isPending()}
            onClick={() => void toggle(control, !checked())}
          >
            <span class="plugin-activation-switch-indicator" aria-hidden="true" />
          </button>
        </div>
        <Show when={runtimeEntry}>
          {(entry) => <div class="plugin-control-detail">{sourceLabel(entry().source)}</div>}
        </Show>
        <Show when={runtimeEntry?.state.status === "failed"}>
          <div class="plugin-control-error">{(runtimeEntry!.state as Extract<PluginRuntimeInventoryEntry["state"], { status: "failed" }>).error}</div>
        </Show>
        <Show when={overridden()}>
          <div class="plugin-control-note">{t("instanceServiceStatus.plugins.globalOverridden")}</div>
        </Show>
      </article>
    )
  }

  const renderScope = (candidate: PluginControlScope) => (
    <button
      type="button"
      role="radio"
      aria-checked={scope() === candidate}
      class="plugin-scope-option"
      classList={{ "plugin-scope-option-selected": scope() === candidate }}
      onClick={() => setScope(candidate)}
    >
      <span class="plugin-scope-option-title">{t(`instanceServiceStatus.plugins.scope.${candidate}`)}</span>
      <span class="plugin-scope-option-detail">{t(`instanceServiceStatus.plugins.scope.${candidate}.detail`)}</span>
    </button>
  )

  return (
    <section
      class="plugin-controls"
      aria-labelledby={props.showHeading !== false ? headingId : undefined}
      aria-label={props.showHeading === false ? t("instanceServiceStatus.sections.plugins") : undefined}
    >
      <Show when={props.showHeading !== false}>
        <div id={headingId} class="text-xs font-medium text-muted uppercase tracking-wide">
          {t("instanceServiceStatus.sections.plugins")}
        </div>
      </Show>

      <div class="plugin-controls-intro">{t("instanceServiceStatus.plugins.description")}</div>

      <fieldset class="plugin-scope-fieldset">
        <legend>{t("instanceServiceStatus.plugins.scope.legend")}</legend>
        <div class="plugin-scope-options" role="radiogroup" aria-label={t("instanceServiceStatus.plugins.scope.legend")}>
          {renderScope("global")}
          {renderScope("project")}
        </div>
        <Show when={!scope()}>
          <div class="plugin-scope-required" role="status">{t("instanceServiceStatus.plugins.scope.required")}</div>
        </Show>
        <Show when={selectedTarget()}>
          {(target) => (
            <div class="plugin-target-path" title={target().path}>
              {t(target().exists
                ? "instanceServiceStatus.plugins.target.existing"
                : "instanceServiceStatus.plugins.target.new", { path: target().path })}
            </div>
          )}
        </Show>
      </fieldset>

      <div class="plugin-controls-toolbar">
        <span>{t("instanceServiceStatus.plugins.runtime.heading")}</span>
        <button
          type="button"
          class="icon-button-compact"
          title={t("instanceServiceStatus.plugins.refresh")}
          aria-label={t("instanceServiceStatus.plugins.refresh")}
          disabled={state().loading || state().refreshing}
          onClick={() => void pluginControlsCache.load(props.instanceId, props.location, { force: true })}
        >
          <RefreshCw class="h-3.5 w-3.5" classList={{ "animate-spin": state().loading || state().refreshing }} aria-hidden="true" />
        </button>
      </div>

      <Show when={snapshot()} fallback={<p class="right-panel-empty-text" role="status">{state().loading
        ? t("instanceServiceStatus.plugins.loading")
        : t("instanceServiceStatus.plugins.errors.load")}</p>}>
        <Show when={runtime().length > 0} fallback={<p class="right-panel-empty-text">{t("instanceServiceStatus.plugins.runtime.empty")}</p>}>
          <div class="plugin-control-list">
            <For each={runtime()}>{(entry) => {
              const control = () => entry.id ? controls().find((candidate) => candidate.id === entry.id) : undefined
              return <Show when={control()} fallback={
                <RuntimeOnlyPlugin
                  entry={entry}
                  status={t(`instanceServiceStatus.plugins.runtime.${runtimeStatus(entry)}`)}
                  source={sourceLabel(entry.source)}
                />
              }>
                {(resolved) => renderControl(resolved(), entry)}
              </Show>
            }}</For>
          </div>
        </Show>

        <Show when={configuredOnly().length > 0}>
          <div class="plugin-controls-subheading">{t("instanceServiceStatus.plugins.inactive.heading")}</div>
          <div class="plugin-control-list">
            <For each={configuredOnly()}>{(control) => renderControl(control)}</For>
          </div>
        </Show>

        <div class="plugin-controls-subheading">{t("instanceServiceStatus.plugins.configured.heading")}</div>
        <Show
          when={(snapshot()?.configured.sources.length ?? 0) + (snapshot()?.configured.rules.length ?? 0) > 0}
          fallback={<p class="right-panel-empty-text">{t("instanceServiceStatus.plugins.configured.empty")}</p>}
        >
          <div class="plugin-configured-list">
            <For each={snapshot()?.configured.sources ?? []}>{(source) => (
              <div class="plugin-configured-entry">
                <span class="plugin-configured-kind">{t("instanceServiceStatus.plugins.configured.source")}</span>
                <code>{source.target}</code>
                <span class="badge-shape plugin-scope-badge">{configScopeLabel(source.scope)}</span>
                <Show when={source.hasOptions}><span class="badge-shape plugin-options-badge">{t("instanceServiceStatus.plugins.configured.options")}</span></Show>
              </div>
            )}</For>
            <For each={snapshot()?.configured.rules ?? []}>{(rule) => (
              <div class="plugin-configured-entry">
                <span class="plugin-configured-kind">{t("instanceServiceStatus.plugins.configured.rule")}</span>
                <code>{rule.enabled ? rule.selector : `-${rule.selector}`}</code>
                <span class="badge-shape plugin-scope-badge">{configScopeLabel(rule.scope)}</span>
              </div>
            )}</For>
          </div>
        </Show>
      </Show>

      <Show when={state().error && snapshot()}>
        <div class="plugin-controls-warning" role="status">{t("instanceServiceStatus.plugins.errors.refresh")}</div>
      </Show>
    </section>
  )

  function sourceLabel(source: PluginRuntimeSource): string {
    if (source.type === "package") return t("instanceServiceStatus.plugins.source.package", { source: source.target })
    if (source.type === "local") return t("instanceServiceStatus.plugins.source.local", { source: source.path })
    return t(`instanceServiceStatus.plugins.source.${source.type}`)
  }

  function scopeLabel(value: PluginControlScope): string {
    return t(`instanceServiceStatus.plugins.scope.${value}`)
  }

  function configScopeLabel(value: PluginConfigScope): string {
    return t(`instanceServiceStatus.plugins.configScope.${value}`)
  }
}

const RuntimeOnlyPlugin: Component<{ entry: PluginRuntimeInventoryEntry; status: string; source: string }> = (props) => (
  <article class="plugin-control-card">
    <div class="plugin-control-name">{props.entry.id ?? runtimeSourceValue(props.entry.source)}</div>
    <div class="plugin-control-meta">
      <span class={`badge-shape plugin-status-badge plugin-status-${runtimeStatus(props.entry)}`}>{props.status}</span>
    </div>
    <div class="plugin-control-detail">{props.source}</div>
    <Show when={props.entry.state.status === "failed"}>
      <div class="plugin-control-error">{(props.entry.state as Extract<PluginRuntimeInventoryEntry["state"], { status: "failed" }>).error}</div>
    </Show>
  </article>
)

function runtimeSourceValue(source: PluginRuntimeSource): string {
  return source.type === "package" ? source.target : source.type === "local" ? source.path : source.type
}

function runtimeStatus(entry?: PluginRuntimeInventoryEntry): "active" | "failed" | "inactive" {
  if (!entry) return "inactive"
  return entry.state.status
}

function errorMessageKey(error: unknown): string {
  if (!(error instanceof HttpResponseError)) return "instanceServiceStatus.plugins.errors.save"
  if (error.status === 403) return "instanceServiceStatus.plugins.errors.forbidden"
  if (error.status === 409) return "instanceServiceStatus.plugins.errors.conflict"
  if (error.status === 422) return "instanceServiceStatus.plugins.errors.invalidConfig"
  return "instanceServiceStatus.plugins.errors.save"
}
