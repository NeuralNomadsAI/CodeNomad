import { batch, createSignal, onCleanup, onMount, type Component } from "solid-js"
import { Toaster } from "solid-toast"
import AlertDialog from "./alert-dialog"
import { SettingsScreen } from "./settings-screen"
import {
  getNativePreferencesRequest,
  acceptNativePreferencesRequest,
  markNativePreferencesReady,
  onNativePreferencesFlushRequested,
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
  let scrollTop = 0
  let scrollTimer: ReturnType<typeof setTimeout> | undefined
  let persistenceQueue = Promise.resolve()
  const persist = (next: () => NativePreferencesRequest, generation?: number) => {
    persistenceQueue = persistenceQueue.catch(() => undefined).then(() => acceptNativePreferencesRequest(next(), generation))
    return persistenceQueue
  }
  const flushScroll = (generation?: number) => {
    clearTimeout(scrollTimer)
    scrollTimer = undefined
    return persist(() => ({ ...request(), scrollTop }), generation)
  }
  const flush = async (generation?: number) => {
    await requestQueue.catch(() => undefined)
    await flushScroll(generation)
  }

  const applyRequest = async (next: NativePreferencesRequest, guard = true) => {
    if (guard && !(await confirmSettingsDiscard())) return
    clearTimeout(scrollTimer)
    if (guard) await persist(() => next)
    const previousInstanceId = request().instanceId
    if (previousInstanceId && previousInstanceId !== next.instanceId) sdkManager.destroyClientsForInstance(previousInstanceId)
    scrollTop = next.scrollTop ?? 0
    batch(() => {
      setRequest(next)
      setActiveSettingsSection(next.section)
    })
  }

  const close = async (guard = true) => {
    if (closePromise) return closePromise
    closePromise = (async () => {
      if (!guard || await confirmSettingsDiscard()) {
        await flush()
        await runNativeWindowAction("close")
      }
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
    let flushGuardReady = false
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
            if (approved) await flushScroll()
            await resolveNativePreferencesTransition(id, approved)
          })
        })
        if (!mounted) return stop()
        subscriptions.push(stop)
        transitionGuardReady = true
      } catch {
        // The host keeps the current document if a guarded transition cannot be confirmed.
      }
      try {
        const stop = await onNativePreferencesFlushRequested(flush)
        if (!mounted) return stop()
        subscriptions.push(stop)
        flushGuardReady = true
      } catch {
        // Readiness also guarantees that native shutdown can drain pending view writes.
      }
      if (requestGuardReady && closeGuardReady && transitionGuardReady && flushGuardReady) await markNativePreferencesReady()
    })()
    onCleanup(() => {
      mounted = false
      clearTimeout(scrollTimer)
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
        scrollPosition={request()}
        onScrollPositionChange={(top) => {
          scrollTop = top
          clearTimeout(scrollTimer)
          scrollTimer = setTimeout(() => { void flushScroll().catch(() => undefined) }, 150)
        }}
        onSectionChange={async (section) => {
          clearTimeout(scrollTimer)
          const next = { ...request(), section, scrollTop: 0 }
          await persist(() => next)
          scrollTop = 0
          setRequest(next)
        }}
        onClose={() => close(false)}
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
