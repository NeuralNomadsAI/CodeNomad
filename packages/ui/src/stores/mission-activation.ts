import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
import type { PluginControlsSnapshot } from "../../../server/src/api-types"
import { MISSIONS_PLUGIN_ID } from "../../../server/src/missions/plugin-id"
import { captureBackendOperation } from "../lib/backend-operation"
import { tGlobal } from "../lib/i18n"
import { showAlertDialog, showConfirmDialog } from "./alerts"
import { pluginControlsCache } from "./plugin-controls"
import "./plugin-controls-events"

export const missionsPluginControl = (snapshot: PluginControlsSnapshot | undefined) =>
  snapshot?.controls.find(control => control.id === MISSIONS_PLUGIN_ID && control.managedBy === "codenomad")

export function useMissionActivation(
  instanceId: Accessor<string | undefined>,
  directory: Accessor<string | undefined>,
  active: Accessor<boolean>,
) {
  const id = createMemo(instanceId)
  const dir = createMemo(directory)
  const target = createMemo(() => {
    const key = id(), path = dir()
    return key && path ? { id: key, location: { directory: path } } : undefined
  })
  const state = () => {
    const owner = target()
    return owner && pluginControlsCache.state(owner.id, owner.location)
  }
  const control = () => missionsPluginControl(state()?.snapshot)
  const unknown = () => !state()?.snapshot
  const enabled = () => !unknown() && control()?.effective !== "disabled"
  const globalEnabled = () => control()?.global !== "disabled"
  const projectOverride = () => control()?.controllingRule?.scope === "project" && enabled() !== globalEnabled()
  const checking = () => Boolean(active() && target() && unknown() && !state()?.error)
  const readFailed = () => Boolean(state()?.error)
  const retry = () => {
    const owner = target()
    if (owner && active() && readFailed()) void pluginControlsCache.load(owner.id, owner.location, { force: true })
  }
  const [pending, setPending] = createSignal<ReturnType<typeof target>>()
  const canToggle = () => active() && Boolean(control()) && pending() !== target() && !state()?.stale && !state()?.refreshing && !readFailed()
    && Boolean(state()?.snapshot?.targets.some(value => value.scope === "global"))
  let lifetime: AbortSignal | undefined
  createEffect(() => {
    const owner = target()
    if (!active() || !owner) return
    const controller = new AbortController()
    lifetime = controller.signal
    const release = pluginControlsCache.acquireDemand(owner.id, owner.location)
    onCleanup(() => { controller.abort(); release() })
  })
  const toggle = async () => {
    const owner = target()
    if (!owner || !canToggle()) return
    const value = !globalEnabled()
    const operation = captureBackendOperation(owner.id, lifetime, () => target() === owner && active())
    if (!operation.current()) return
    setPending(owner)
    try {
      if (!value && !await showConfirmDialog(tGlobal("missions.activation.disableConfirm"), { variant: "warning" }, operation.signal)) return
      if (!operation.current() || value === globalEnabled()) return
      await pluginControlsCache.mutate(owner.id, owner.location, MISSIONS_PLUGIN_ID, "global", value, { reconcile: true })
    } catch {
      if (operation.current()) {
        void pluginControlsCache.load(owner.id, owner.location, { force: true })
        showAlertDialog(tGlobal("instanceServiceStatus.plugins.errors.save", {
          name: tGlobal("instanceShell.rightPanel.tabs.missions"), scope: tGlobal("instanceServiceStatus.plugins.scope.global"),
        }), { variant: "error" })
      }
    } finally {
      setPending(current => current === owner ? undefined : current)
    }
  }
  return { enabled, unknown, checking, readFailed, retry, canToggle, toggle, projectOverride, globalEnabled }
}
