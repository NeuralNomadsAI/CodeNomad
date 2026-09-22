import { For, Show, createEffect, createMemo, createSignal, createUniqueId, type Component } from "solid-js"
import { RefreshCw } from "lucide-solid"
import Switch from "@suid/material/Switch"
import type {
  PluginActivationControl,
  PluginControlLocation,
  PluginControlScope,
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

export const PluginActivationControls: Component<PluginActivationControlsProps> = (props) => {
  const { t } = useI18n()
  const [pending, setPending] = createSignal<Set<string>>(new Set())
  const headingId = `plugin-controls-${createUniqueId()}`
  const directory = createMemo(() => props.location.directory)
  const requestLocation = (): PluginControlLocation => ({ directory: directory() })
  const state = createMemo(() => pluginControlsCache.state(props.instanceId, requestLocation()))
  const snapshot = createMemo(() => state().snapshot)
  const controls = createMemo(() => (
    snapshot()?.controls.filter((control) => control.runtime?.source.type !== "builtin") ?? []
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

  const setPendingPlugin = (pluginId: string, value: boolean) => {
    setPending((previous) => {
      const next = new Set(previous)
      if (value) next.add(pluginId)
      else next.delete(pluginId)
      return next
    })
  }

  const toggle = async (control: PluginActivationControl, scope: PluginControlScope, enabled: boolean) => {
    if (pending().has(control.id)) return
    const requestGeneration = locationGeneration
    setPendingPlugin(control.id, true)
    try {
      const response = await pluginControlsCache.mutate(props.instanceId, requestLocation(), control.id, scope, enabled)
      if (requestGeneration !== locationGeneration) return
      showToastNotification({
        variant: "success",
        message: t(response.changed
          ? "instanceServiceStatus.plugins.toast.ruleSaved"
          : "instanceServiceStatus.plugins.toast.ruleUnchanged", {
          name: control.id,
          scope: scopeLabel(scope),
        }),
      })
    } catch (error) {
      log.error("Failed to update plugin activation rule", { pluginId: control.id, scope, error })
      if (requestGeneration === locationGeneration) {
        showToastNotification({ variant: "error", message: t(errorMessageKey(error)) })
      }
    } finally {
      if (requestGeneration === locationGeneration) setPendingPlugin(control.id, false)
    }
  }

  const renderControl = (control: PluginActivationControl) => {
    const isPending = () => pending().has(control.id)
    const renderSwitch = (scope: PluginControlScope) => {
      const checked = () => scopeChecked(control, scope)
      return (
        <div class="plugin-control-switch" data-scope={scope}>
          <Switch
            checked={checked()}
            disabled={isPending()}
            color="success"
            size="small"
            inputProps={{
              "aria-label": t("instanceServiceStatus.plugins.toggleAriaLabel", {
                name: `${control.id} — ${scopeLabel(scope)}`,
              }),
            }}
            onChange={(_, nextChecked) => {
              if (isPending()) return
              void toggle(control, scope, Boolean(nextChecked))
            }}
          />
        </div>
      )
    }
    return (
      <div class="plugin-control-row" data-plugin-id={control.id}>
        <span class="plugin-control-name">{control.id}</span>
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
        <span class="plugin-control-scope-label">{scopeLabel("global")}</span>
        <span class="plugin-control-scope-label">{scopeLabel("project")}</span>
      </div>

      <Show when={snapshot()} fallback={<p class="right-panel-empty-text" role="status">{state().loading
        ? t("instanceServiceStatus.plugins.loading")
        : state().error
          ? t("instanceServiceStatus.plugins.errors.load")
          : t("instanceServiceStatus.plugins.loading")}</p>}>
        <Show when={controls().length > 0} fallback={<p class="right-panel-empty-text">{t("instanceServiceStatus.plugins.empty")}</p>}>
          <div class="plugin-control-list">
            <For each={controls()}>{renderControl}</For>
          </div>
        </Show>
      </Show>

      <Show when={state().error && snapshot()}>
        <div class="plugin-controls-warning" role="status">{t("instanceServiceStatus.plugins.errors.refresh")}</div>
      </Show>
    </section>
  )

  function scopeLabel(value: PluginControlScope): string {
    return t(`instanceServiceStatus.plugins.scope.${value}`)
  }
}

function scopeChecked(control: PluginActivationControl, scope: PluginControlScope): boolean {
  const scoped = control[scope]
  return scoped === "default" ? control.effective !== "disabled" : scoped === "enabled"
}

function errorMessageKey(error: unknown): string {
  if (!(error instanceof HttpResponseError)) return "instanceServiceStatus.plugins.errors.save"
  if (error.status === 403) return "instanceServiceStatus.plugins.errors.forbidden"
  if (error.status === 409) return "instanceServiceStatus.plugins.errors.conflict"
  if (error.status === 422) return "instanceServiceStatus.plugins.errors.invalidConfig"
  return "instanceServiceStatus.plugins.errors.save"
}
