import { createSignal, onCleanup } from "solid-js"
import Switch from "@suid/material/Switch"
import type { PluginActivationControl, PluginControlLocation, PluginControlScope } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { captureBackendOperation } from "../lib/backend-operation"
import { getLogger } from "../lib/logger"
import { showToastNotification } from "../lib/notifications"
import { HttpResponseError } from "../lib/retryable-file-search"
import { pluginControlsCache } from "../stores/plugin-controls"
import { ACCENT_SWITCH_SX } from "./settings/settings-switch"

const log = getLogger("session")
const [pending, setPending] = createSignal<ReadonlySet<string>>(new Set())
const pendingKey = (instanceId: string, location: PluginControlLocation, scope: PluginControlScope, pluginId: string) =>
  JSON.stringify([instanceId, location.directory, scope, pluginId])

/** One activation mutation per plugin, scope and Location at a time, shared by every surface that shows the switch. */
export function isPluginActivationPending(instanceId: string, location: PluginControlLocation, scope: PluginControlScope, pluginId: string): boolean {
  return pending().has(pendingKey(instanceId, location, scope, pluginId))
}

export function pluginScopeChecked(control: PluginActivationControl, scope: PluginControlScope): boolean {
  const scoped = control[scope]
  if (scoped !== "default") return scoped === "enabled"
  return scope === "project" ? pluginScopeChecked(control, "global") : true
}

function errorMessageKey(error: unknown): string {
  if (!(error instanceof HttpResponseError)) return "instanceServiceStatus.plugins.errors.save"
  if (error.status === 403) return "instanceServiceStatus.plugins.errors.forbidden"
  if (error.status === 409) return "instanceServiceStatus.plugins.errors.conflict"
  if (error.status === 422) return "instanceServiceStatus.plugins.errors.invalidConfig"
  return "instanceServiceStatus.plugins.errors.save"
}

/**
 * The Global or Project activation switch of one plugin: the native activation-rule mutation, without confirmation.
 * Feedback belongs to the surface that started it, while it still shows the same Location.
 */
export function PluginActivationSwitch(props: {
  instanceId: string
  location: PluginControlLocation
  control: PluginActivationControl | undefined
  scope: PluginControlScope
  available: boolean
  /** Accessible name; it includes the plugin's name and the scope. */
  label: string
  /** The plugin's shown name in error feedback; its ID otherwise. */
  name?: string
  describedBy?: string
  active?: boolean
  /** Shown but not writable here, with this reason as its tooltip; it stays focusable. */
  lockedReason?: string
  /** An integration's switch: the accent switch of Yolo and the settings, where a plain plugin's is the green variant. */
  integration?: boolean
}) {
  const { t } = useI18n()
  let disposed = false
  onCleanup(() => { disposed = true })
  const isPending = () => Boolean(props.control && isPluginActivationPending(props.instanceId, props.location, props.scope, props.control.id))
  const toggle = async (control: PluginActivationControl, enabled: boolean) => {
    const instanceId = props.instanceId, location = { directory: props.location.directory }, scope = props.scope
    const operation = captureBackendOperation(instanceId)
    if (!operation.current()) return
    const key = pendingKey(instanceId, location, scope, control.id)
    if (pending().has(key)) return
    setPending(current => new Set(current).add(key))
    try {
      await pluginControlsCache.mutate(instanceId, location, control.id, scope, enabled)
    } catch (error) {
      log.error("Failed to update plugin activation rule", { pluginId: control.id, scope, error })
      if (operation.current() && !disposed && props.active !== false && props.instanceId === instanceId && props.location.directory === location.directory) {
        showToastNotification({ category: "opencode", variant: "error",
          message: t(errorMessageKey(error), { name: props.name ?? control.id, scope: t(`instanceServiceStatus.plugins.scope.${scope}`) }) })
      }
    } finally {
      setPending(current => { const next = new Set(current); next.delete(key); return next })
    }
  }
  return (
    <div class="plugin-control-switch" data-scope={props.scope} data-locked={props.lockedReason ? "" : undefined}
      data-integration={props.integration ? "" : undefined} title={props.lockedReason}>
      <Switch
        checked={props.control ? pluginScopeChecked(props.control, props.scope) : false}
        disabled={!props.available}
        color={props.integration ? "primary" : "success"}
        size="small"
        sx={props.integration ? ACCENT_SWITCH_SX : undefined}
        inputProps={{
          "aria-label": props.label,
          "aria-describedby": props.describedBy,
          "aria-disabled": isPending() || !props.available || Boolean(props.lockedReason),
          "aria-busy": isPending(),
        }}
        onChange={(event, nextChecked) => {
          const current = props.control
          if (isPending() || !props.available || props.lockedReason || !current) {
            // SUID restores the controlled checked value before calling us.
            // Cancel native activation too, while retaining keyboard focus.
            event.preventDefault()
            return
          }
          void toggle(current, Boolean(nextChecked))
        }}
      />
    </div>
  )
}
