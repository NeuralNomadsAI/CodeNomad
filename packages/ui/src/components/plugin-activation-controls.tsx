import { For, Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup, type Component } from "solid-js"
import { Tooltip } from "@kobalte/core/tooltip"
import { RefreshCw } from "lucide-solid"
import Switch from "@suid/material/Switch"
import type {
  PluginActivationControl,
  PluginControlLocation,
  PluginControlScope,
  PluginRuntimeInventoryEntry,
  PluginRuntimeSource,
} from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { getLogger } from "../lib/logger"
import { showToastNotification } from "../lib/notifications"
import { HttpResponseError } from "../lib/retryable-file-search"
import { pluginControlsCache } from "../stores/plugin-controls"
import { PluginPackageAction } from "./plugin-package-action"
import "../stores/plugin-controls-events"

interface PluginActivationControlsProps {
  instanceId: string
  location: PluginControlLocation
  active?: boolean
}

const log = getLogger("session")

const pendingKey = (scope: PluginControlScope, pluginId: string): string => `${scope}:${pluginId}`

export const PluginActivationControls: Component<PluginActivationControlsProps> = (props) => {
  const { t } = useI18n()
  const [pending, setPending] = createSignal<Set<string>>(new Set())
  const headingId = `plugin-controls-${createUniqueId()}`
  const noticeId = `${headingId}-notice`
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
  const controlsById = createMemo(() => new Map(controls().map((control) => [control.id, control])))
  const controlIds = createMemo(() => [...controlsById().keys()])
  // A package can fail before exporting a plugin ID. Keep its native target
  // actionable without inventing an ID that could become an activation rule.
  const packagesByTarget = createMemo(() => {
    const represented = new Set(controls().flatMap(control =>
      control.runtime?.source.type === "package" ? [control.runtime.source.target] : []))
    const packages = new Map<string, PluginRuntimeInventoryEntry>()
    for (const entry of snapshot()?.runtime ?? []) {
      if (entry.source.type !== "package" || represented.has(entry.source.target)) continue
      if (!packages.has(entry.source.target)) packages.set(entry.source.target, entry)
    }
    return packages
  })
  const packageTargets = createMemo(() => [...packagesByTarget().keys()])
  let currentIdentity: string | undefined
  let locationGeneration = 0
  // The admitted write may finish after a project tab or visibility wrapper
  // disposes this surface. Only its live owner may publish presentation feedback.
  onCleanup(() => { locationGeneration += 1 })

  createEffect(() => {
    const instanceId = props.instanceId
    const location = requestLocation()
    const identity = JSON.stringify([instanceId, location.directory])
    if (currentIdentity !== identity) {
      currentIdentity = identity
      locationGeneration += 1
      setPending(new Set<string>())
    }
    if (props.active === false) return
    onCleanup(pluginControlsCache.acquireDemand(instanceId, location))
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
      await pluginControlsCache.mutate(props.instanceId, requestLocation(), control.id, scope, enabled)
    } catch (error) {
      log.error("Failed to update plugin activation rule", { pluginId: control.id, scope, error })
      if (requestGeneration === locationGeneration && props.active !== false) {
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

  const renderControl = (pluginId: string) => {
    // Key rows by ID, but read every displayed value from the current snapshot.
    // Passive refreshes must not replace the focused row's DOM.
    const control = createMemo(() => controlsById().get(pluginId))
    const failed = () => control()?.runtime?.state.status === "failed"
    const failureMessage = () => {
      const state = control()?.runtime?.state
      return state?.status === "failed" ? state.error : undefined
    }
    const overridden = () => Boolean(control() && control()?.project !== "default")
    const isAvailable = (scope: PluginControlScope): boolean =>
      snapshot()?.targets.some((target) => target.scope === scope) === true
    const details = () => {
      const current = control()
      const lines = [pluginId]
      if (current?.runtime) lines.push(sourceLabel(current.runtime.source))
      if (failed()) lines.push(`${t("instanceServiceStatus.plugins.runtime.failed")} — ${failureMessage() ?? ""}`)
      else if (overridden()) lines.push(t("instanceServiceStatus.plugins.globalOverridden"))
      for (const target of snapshot()?.targets ?? []) {
        lines.push(`${scopeLabel(target.scope)} — ${target.path}`)
      }
      if (!isAvailable("project")) lines.push(t("instanceServiceStatus.plugins.scope.unavailable"))
      if (state().error) lines.push(t("instanceServiceStatus.plugins.errors.refresh"))
      return lines.map(bidi).join("\n")
    }
    const renderSwitch = (scope: PluginControlScope) => {
      const checked = () => {
        const current = control()
        return current ? scopeChecked(current, scope) : false
      }
      const available = () => isAvailable(scope)
      const isPending = () => pending().has(pendingKey(scope, pluginId))
      const describedBy = () => available()
        ? (scope === "global" ? globalLabelId : projectLabelId)
        : `${scope === "global" ? globalLabelId : projectLabelId} ${noticeId}`
      return (
        <div
          class="plugin-control-switch"
          data-scope={scope}
        >
          <Switch
            checked={checked()}
            disabled={!available()}
            color="success"
            size="small"
            inputProps={{
              "aria-label": bidi(t("instanceServiceStatus.plugins.toggleAriaLabel", {
                name: `${pluginId} — ${scopeLabel(scope)}`,
              })),
              "aria-describedby": describedBy(),
              "aria-disabled": isPending() || !available(),
              "aria-busy": isPending(),
            }}
            onChange={(event, nextChecked) => {
              const current = control()
              if (isPending() || !available() || !current) {
                // SUID restores the controlled checked value before calling us.
                // Cancel native activation too, while retaining keyboard focus.
                event.preventDefault()
                return
              }
              void toggle(current, scope, Boolean(nextChecked))
            }}
          />
        </div>
      )
    }
    const nameId = `${headingId}-name-${pluginId}`
    return (
      <div class="plugin-control-row" data-plugin-id={pluginId} role="group" aria-labelledby={nameId}>
        <div class="plugin-control-identity"><Tooltip placement="top-start" openDelay={300}>
          <Tooltip.Trigger as="span" tabindex="0" id={nameId} class="plugin-control-name"><bdi>{pluginId}</bdi></Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content class="section-info-tooltip plugin-control-tooltip">{details()}</Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip><PluginPackageAction instanceId={props.instanceId} location={requestLocation()} source={control()?.runtime?.source} active={props.active} /></div>
        {renderSwitch("global")}
        {renderSwitch("project")}
      </div>
    )
  }

  const renderPackage = (target: string) => {
    const entry = () => packagesByTarget().get(target)
    const nameId = createUniqueId()
    const details = () => {
      const current = entry()
      const lines = [current ? sourceLabel(current.source) : target]
      if (current?.state.status === "failed") {
        lines.push(`${t("instanceServiceStatus.plugins.runtime.failed")} — ${current.state.error}`)
      }
      return lines.map(bidi).join("\n")
    }
    return <div class="plugin-control-row" data-package-target={target} role="group" aria-labelledby={nameId}>
      <div class="plugin-control-identity">
        <Tooltip placement="top-start" openDelay={300}>
          <Tooltip.Trigger as="span" tabindex="0" id={nameId} class="plugin-control-name"><bdi>{target}</bdi></Tooltip.Trigger>
          <Tooltip.Portal><Tooltip.Content class="section-info-tooltip plugin-control-tooltip">{details()}</Tooltip.Content></Tooltip.Portal>
        </Tooltip>
        <PluginPackageAction instanceId={props.instanceId} location={requestLocation()} source={entry()?.source} active={props.active} />
      </div>
    </div>
  }

  return (
    <section
      class="plugin-controls"
      aria-label={t("instanceServiceStatus.sections.plugins")}
    >
      <Show when={snapshot() && !snapshot()?.targets.some((target) => target.scope === "project")}>
        <span id={noticeId} class="sr-only">{t("instanceServiceStatus.plugins.scope.unavailable")}</span>
      </Show>

      <div class="plugin-controls-header">
        <button
          type="button"
          class="icon-button-compact"
          title={t("instanceServiceStatus.plugins.refresh")}
          aria-label={t("instanceServiceStatus.plugins.refresh")}
          aria-busy={state().loading || state().refreshing}
          disabled={state().loading || state().refreshing}
          onClick={() => void pluginControlsCache.load(props.instanceId, requestLocation(), { force: true })}
        >
          <RefreshCw class="h-3.5 w-3.5" classList={{ "animate-spin": state().loading || state().refreshing }} aria-hidden="true" />
        </button>
        <span id={globalLabelId} class="plugin-control-scope-label">{scopeLabel("global")}</span>
        <span id={projectLabelId} class="plugin-control-scope-label">{scopeLabel("project")}</span>
      </div>

      <Show when={snapshot()} fallback={
        <div class="right-panel-empty-text" role="status">
          <p>{state().loading
            ? t("instanceServiceStatus.plugins.loading")
            : state().error
              ? t("instanceServiceStatus.plugins.errors.load")
              : t("instanceServiceStatus.plugins.loading")}</p>
        </div>
      }>
        <Show when={controlIds().length + packageTargets().length > 0} fallback={<p class="right-panel-empty-text">{t("instanceServiceStatus.plugins.empty")}</p>}>
          <div class="plugin-control-list">
            <For each={controlIds()}>{renderControl}</For>
            <For each={packageTargets()}>{renderPackage}</For>
          </div>
        </Show>
      </Show>
    </section>
  )

  function scopeLabel(value: PluginControlScope): string {
    return t(`instanceServiceStatus.plugins.scope.${value}`)
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
