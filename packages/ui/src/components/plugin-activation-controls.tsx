import { For, Show, createEffect, createMemo, createSignal, createUniqueId, type Component } from "solid-js"
import { RefreshCw } from "lucide-solid"
import Switch from "@suid/material/Switch"
import type {
  PluginActivationControl,
  PluginControlLocation,
  PluginControlScope,
  PluginRuntimeSource,
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
  active?: boolean
}

const log = getLogger("session")

const pendingKey = (scope: PluginControlScope, pluginId: string): string => `${scope}:${pluginId}`

export const PluginActivationControls: Component<PluginActivationControlsProps> = (props) => {
  const { t } = useI18n()
  const [pending, setPending] = createSignal<Set<string>>(new Set())
  const headingId = `plugin-controls-${createUniqueId()}`
  const globalLabelId = `plugin-controls-${createUniqueId()}-global`
  const projectLabelId = `plugin-controls-${createUniqueId()}-project`
  const directory = createMemo(() => props.location.directory)
  let cachedLocation: PluginControlLocation | undefined
  const requestLocation = (): PluginControlLocation => {
    if (!cachedLocation || cachedLocation.directory !== directory()) {
      cachedLocation = { directory: directory() }
    }
    return cachedLocation
  }
  const state = createMemo(() => pluginControlsCache.state(props.instanceId, requestLocation()))
  const snapshot = createMemo(() => state().snapshot)
  const controls = createMemo(() => (
    snapshot()?.controls.filter((control) => !control.builtin && control.runtime?.source.type !== "builtin") ?? []
  ))
  let currentIdentity: string | undefined
  let demandedIdentity: string | undefined
  let locationGeneration = 0

  createEffect(() => {
    const instanceId = props.instanceId
    const location = requestLocation()
    const identity = JSON.stringify([instanceId, location.directory])
    if (currentIdentity !== identity) {
      currentIdentity = identity
      locationGeneration += 1
      setPending(new Set<string>())
    }
    const current = state()
    if (props.active === false) {
      demandedIdentity = undefined
      return
    }
    const firstDemand = demandedIdentity !== identity
    demandedIdentity = identity
    if (current.stale || (!current.snapshot && !current.loading && (!current.error || firstDemand))) {
      void pluginControlsCache.load(instanceId, location, { force: Boolean(current.error) })
    }
  })

  const setPendingPlugin = (scope: PluginControlScope, pluginId: string, value: boolean) => {
    setPending((previous) => {
      const next = new Set(previous)
      if (value) next.add(pendingKey(scope, pluginId))
      else next.delete(pendingKey(scope, pluginId))
      return next
    })
  }

  const toggle = async (control: PluginActivationControl, scope: PluginControlScope, enabled: boolean) => {
    const key = pendingKey(scope, control.id)
    if (pending().has(key)) return
    const requestGeneration = locationGeneration
    setPendingPlugin(scope, control.id, true)
    try {
      const response = await pluginControlsCache.mutate(props.instanceId, requestLocation(), control.id, scope, enabled)
      if (requestGeneration !== locationGeneration) return
      const base = t(response.changed
        ? "instanceServiceStatus.plugins.toast.ruleSaved"
        : "instanceServiceStatus.plugins.toast.ruleUnchanged", {
        name: control.id,
        scope: scopeLabel(scope),
      })
      showToastNotification({
        variant: "success",
        message: response.changed && response.reloadPending ? `${base} ${t("instanceServiceStatus.plugins.toast.reloadNote")}` : base,
      })
    } catch (error) {
      log.error("Failed to update plugin activation rule", { pluginId: control.id, scope, error })
      if (requestGeneration === locationGeneration) {
        showToastNotification({
          variant: "error",
          message: t(errorMessageKey(error), { name: control.id, scope: scopeLabel(scope) }),
        })
      }
    } finally {
      if (requestGeneration === locationGeneration) setPendingPlugin(scope, control.id, false)
    }
  }

  const bidi = (text: string): string => `⁨${text}⁩`

  const sourceLabel = (source: PluginRuntimeSource): string => {
    if (source.type === "package") return t("instanceServiceStatus.plugins.source.package", { source: source.target })
    if (source.type === "local") return t("instanceServiceStatus.plugins.source.local", { source: source.path })
    if (source.type === "builtin") return t("instanceServiceStatus.plugins.source.builtin")
    return t("instanceServiceStatus.plugins.source.sdk")
  }

  const renderControl = (control: PluginActivationControl) => {
    const failed = () => control.runtime?.state.status === "failed"
    const failureMessage = () => failed()
      ? (control.runtime?.state.status === "failed" ? control.runtime.state.error : undefined)
      : undefined
    const overridden = () => control.project !== "default"
    const statusText = (): string | undefined => {
      if (failed()) return `${t("instanceServiceStatus.plugins.runtime.failed")}${failureMessage() ? ` — ${failureMessage()}` : ""}`
      if (overridden()) return t("instanceServiceStatus.plugins.globalOverridden")
      return undefined
    }
    const targetPath = (): string | undefined => control.controllingRule?.path
      ?? snapshot()?.targets.find((candidate) => candidate.scope === (control.project !== "default" ? "project" : "global"))?.path
    const nameTitle = () => {
      const target = targetPath()
      const status = statusText()
      if (status) return target ? bidi(`${control.id} — ${status} — ${target}`) : bidi(`${control.id} — ${status}`)
      return target
        ? bidi(`${control.id} — ${t("instanceServiceStatus.plugins.target.existing", { path: target })}`)
        : control.id
    }
    const detailTitle = () => {
      const target = control.controllingRule?.path
        ?? snapshot()?.targets.find((candidate) => candidate.scope === (control.project !== "default" ? "project" : "global"))?.path
      const status = statusText()
      // A truncated status line must keep its full text reachable: prefer the
      // status over the rule target instead of repeating the target twice.
      if (status) return target ? bidi(`${status} — ${target}`) : status
      return target
        ? bidi(`${control.id} — ${t("instanceServiceStatus.plugins.target.existing", { path: target })}`)
        : control.id
    }
    const isAvailable = (scope: PluginControlScope): boolean =>
      snapshot()?.targets.some((target) => target.scope === scope) === true
    const scopeReason = (scope: PluginControlScope): string => isAvailable(scope)
      ? t(`instanceServiceStatus.plugins.scope.${scope}.detail`)
      : scope === "project"
        ? t("instanceServiceStatus.plugins.scope.unavailable")
        : t(`instanceServiceStatus.plugins.scope.${scope}.detail`)
    const renderSwitch = (scope: PluginControlScope) => {
      const checked = () => scopeChecked(control, scope)
      const available = () => isAvailable(scope)
      const isPending = () => pending().has(pendingKey(scope, control.id))
      const describedBy = () => available()
        ? (scope === "global" ? globalLabelId : projectLabelId)
        : `${scope === "global" ? globalLabelId : projectLabelId} ${noticeId}`
      // Native tooltips do not fire on disabled inputs and disabled inputs
      // leave the tab order, so the reason lives on the hoverable wrapper and
      // in screen-reader text instead of the input title. Available switches
      // already describe themselves through the header labels, so only
      // unavailable lanes carry a tooltip.
      return (
        <div
          class="plugin-control-switch"
          data-scope={scope}
          title={available() ? undefined : scopeReason(scope)}
        >
          <Switch
            checked={checked()}
            disabled={isPending() || !available()}
            color="success"
            size="small"
            inputProps={{
              "aria-label": bidi(t("instanceServiceStatus.plugins.toggleAriaLabel", {
                name: `${control.id} — ${scopeLabel(scope)}`,
              })),
              "aria-describedby": describedBy(),
              "aria-busy": isPending(),
            }}
            onChange={(_, nextChecked) => {
              if (isPending() || !available()) return
              void toggle(control, scope, Boolean(nextChecked))
            }}
          />
        </div>
      )
    }
    const nameId = `${headingId}-name-${control.id}`
    return (
      <div class="plugin-control-row" data-plugin-id={control.id} role="group" aria-labelledby={nameId}>
        <div class="min-w-0">
          <span id={nameId} class="plugin-control-name" title={nameTitle()} tabindex="0"><bdi>{control.id}</bdi></span>
          <div class="plugin-control-sub" title={detailTitle()} tabindex="0">
            <Show when={failed()} fallback={
              <Show when={overridden()} fallback={
                <Show when={control.runtime} fallback={
                  <span>{t(`instanceServiceStatus.plugins.ruleState.${control.effective}`)}</span>
                }>
                  {(runtime) => <span>{sourceLabel(runtime().source)}</span>}
                </Show>
              }>
                <span class={`status-dot ${control.effective === "enabled" ? "ready" : "stopped"}`} aria-hidden="true" />
                <span>{t("instanceServiceStatus.plugins.globalOverridden")}</span>
              </Show>
            }>
              <span class="status-dot error" aria-hidden="true" />
              <span><bdi>{t("instanceServiceStatus.plugins.runtime.failed")}{failureMessage() ? ` — ${failureMessage()}` : ""}</bdi></span>
            </Show>
          </div>
        </div>
        {renderSwitch("global")}
        {renderSwitch("project")}
      </div>
    )
  }

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
      <p class="plugin-controls-description">{t("instanceServiceStatus.plugins.description")}</p>
      <Show when={snapshot() && !snapshot()?.targets.some((target) => target.scope === "project")}>
        <p id={noticeId} class="plugin-controls-notice" role="note">{t("instanceServiceStatus.plugins.scope.unavailable")}</p>
      </Show>

      <div class="plugin-controls-header">
        <button
          type="button"
          class="icon-button-compact"
          title={t("instanceServiceStatus.plugins.refresh")}
          aria-label={t("instanceServiceStatus.plugins.refresh")}
          disabled={state().loading || state().refreshing}
          onClick={() => void pluginControlsCache.load(props.instanceId, requestLocation(), { force: true })}
        >
          <RefreshCw class="h-3.5 w-3.5" classList={{ "animate-spin": state().loading || state().refreshing }} aria-hidden="true" />
        </button>
        <span class="sr-only">{t("instanceServiceStatus.plugins.scope.legend")}</span>
        <span id={globalLabelId} class="plugin-control-scope-label" title={t("instanceServiceStatus.plugins.scope.global.detail")}>{scopeLabel("global")}</span>
        <span
          id={projectLabelId}
          class="plugin-control-scope-label"
          title={!snapshot() || snapshot()?.targets.some((target) => target.scope === "project")
            ? t("instanceServiceStatus.plugins.scope.project.detail")
            : t("instanceServiceStatus.plugins.scope.unavailable")}
        >{scopeLabel("project")}</span>
      </div>

      <Show when={snapshot()} fallback={
        <div class="right-panel-empty-text" role="status">
          <p>{state().loading
            ? t("instanceServiceStatus.plugins.loading")
            : state().error
              ? t("instanceServiceStatus.plugins.errors.load")
              : t("instanceServiceStatus.plugins.loading")}</p>
          <Show when={!state().loading && state().error}>
            <button
              type="button"
              class="button-tertiary"
              onClick={() => void pluginControlsCache.load(props.instanceId, requestLocation(), { force: true })}
            >
              {t("instanceServiceStatus.plugins.refresh")}
            </button>
          </Show>
        </div>
      }>
        <Show when={controls().length > 0} fallback={<p class="right-panel-empty-text">{t("instanceServiceStatus.plugins.empty")}</p>}>
          <div class="plugin-control-list">
            <For each={controls()}>{renderControl}</For>
          </div>
        </Show>
        <div class="plugin-controls-footer">
          <For each={snapshot()?.targets ?? []}>{(target) => {
            const line = `${scopeLabel(target.scope)} — ${target.exists
              ? t("instanceServiceStatus.plugins.target.existing", { path: target.path })
              : t("instanceServiceStatus.plugins.target.new", { path: target.path })}`
            return (
              <div class="truncate" title={bidi(line)} tabindex="0">
                {bidi(line)}
              </div>
            )
          }}</For>
        </div>
      </Show>

      <Show when={state().error && snapshot()}>
        <div class="plugin-controls-warning" role="status">{t("instanceServiceStatus.plugins.errors.refresh")}</div>
      </Show>
    </section>
  )

  function scopeLabel(value: PluginControlScope): string {
    return t(`instanceServiceStatus.plugins.scope.${value}`)
  }

  function unavailableId(scope: PluginControlScope, pluginId: string): string {
    return `${headingId}-unavailable-${scope}-${pluginId}`
  }
}

function scopeChecked(control: PluginActivationControl, scope: PluginControlScope): boolean {
  const scoped = control[scope]
  if (scoped !== "default") return scoped === "enabled"
  return scope === "project" ? scopeChecked(control, "global") : true
}

function errorMessageKey(error: unknown): string {
  if (!(error instanceof HttpResponseError)) return "instanceServiceStatus.plugins.errors.save"
  if (error.status === 403) return "instanceServiceStatus.plugins.errors.forbidden"
  if (error.status === 409) return "instanceServiceStatus.plugins.errors.conflict"
  if (error.status === 422) return "instanceServiceStatus.plugins.errors.invalidConfig"
  return "instanceServiceStatus.plugins.errors.save"
}
