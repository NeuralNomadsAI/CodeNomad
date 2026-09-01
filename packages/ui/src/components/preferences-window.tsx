import { createSignal, onCleanup, onMount, type Component } from "solid-js"
import { Toaster } from "solid-toast"
import AlertDialog from "./alert-dialog"
import { SettingsScreen } from "./settings-screen"
import {
  getNativePreferencesRequest,
  acceptNativePreferencesRequest,
  markNativePreferencesReady,
  onNativePreferencesCloseRequested,
  onNativePreferencesTransitionRequested,
  onNativePreferencesRequest,
  resolveNativePreferencesTransition,
  type NativePreferencesRequest,
} from "../lib/native/preferences-window"
import { runNativeWindowAction } from "../lib/native/window-controls"
import { setActiveSettingsSection } from "../stores/settings-screen"
import { confirmSettingsDiscard } from "../stores/settings-dirty-guard"
import { sdkManager } from "../lib/sdk-manager"

export const PreferencesWindow: Component = () => {
  const [request, setRequest] = createSignal<NativePreferencesRequest>({ section: "general" })
  const subscriptions: Array<() => void> = []
  let requestQueue = Promise.resolve()
  let closePromise: Promise<void> | undefined

  const applyRequest = async (next: NativePreferencesRequest, guard = true) => {
    if (guard && !(await confirmSettingsDiscard())) return
    if (guard) await acceptNativePreferencesRequest(next)
    const previousInstanceId = request().instanceId
    if (previousInstanceId && previousInstanceId !== next.instanceId) sdkManager.destroyClientsForInstance(previousInstanceId)
    setRequest(next)
    setActiveSettingsSection(next.section)
  }

  const close = async () => {
    if (closePromise) return closePromise
    closePromise = (async () => {
      if (await confirmSettingsDiscard()) await runNativeWindowAction("close")
    })().finally(() => {
      closePromise = undefined
    })
    return closePromise
  }

  onMount(() => {
    let mounted = true
    let receivedLiveUpdate = false
    let requestGuardReady = false
    let closeGuardReady = false
    let transitionGuardReady = false
    void (async () => {
      try {
        const stop = await onNativePreferencesRequest((next) => {
          receivedLiveUpdate = true
          if (mounted) requestQueue = requestQueue.catch(() => undefined).then(() => applyRequest(next))
        })
        if (!mounted) return stop()
        subscriptions.push(stop)
        requestGuardReady = true
      } catch {
        // The URL remains the initial authority if the host event bridge is unavailable.
      }
      try {
        const initial = await getNativePreferencesRequest()
        if (mounted && !receivedLiveUpdate) await applyRequest(initial, false)
      } catch {
        // Keep the General section fallback.
      }
      try {
        const stop = await onNativePreferencesCloseRequested(() => void close())
        if (!mounted) return stop()
        subscriptions.push(stop)
        closeGuardReady = true
      } catch {
        // Custom titlebar close remains available if the native close bridge is unavailable.
      }
      try {
        const stop = await onNativePreferencesTransitionRequested((id) => {
          requestQueue = requestQueue.catch(() => undefined).then(async () => {
            const approved = await confirmSettingsDiscard()
            await resolveNativePreferencesTransition(id, approved)
          })
        })
        if (!mounted) return stop()
        subscriptions.push(stop)
        transitionGuardReady = true
      } catch {
        // The host keeps the current document if a guarded transition cannot be confirmed.
      }
      if (requestGuardReady && closeGuardReady && transitionGuardReady) await markNativePreferencesReady()
    })()
    onCleanup(() => {
      mounted = false
      subscriptions.splice(0).forEach((stop) => stop())
      const instanceId = request().instanceId
      if (instanceId) sdkManager.destroyClientsForInstance(instanceId)
    })
  })

  return (
    <>
      <SettingsScreen
        standalone
        providerContext={{ instanceId: request().instanceId, location: request().location }}
        onSectionChange={async (section) => {
          const next = { ...request(), section }
          await acceptNativePreferencesRequest(next)
          setRequest(next)
        }}
        onClose={() => runNativeWindowAction("close")}
      />
      <AlertDialog />
      <Toaster
        position="top-right"
        gutter={16}
        toastOptions={{ duration: 8000, className: "bg-transparent border-none shadow-none p-0" }}
      />
    </>
  )
}
