import { createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { isWebHost } from "../runtime-env"
import { authRecovery, localHttp } from "../auth-recovery"
import { appSessionRestoreGateActive } from "../../stores/app-session-restore-gate"
import { appTabs, selectAppTab, selectInstanceTab } from "../../stores/app-tabs"
import { preferences } from "../../stores/preferences"
import { parseInstanceKey } from "../backend-identity"
import { captureBackendOperation } from "../backend-operation"
import { instances } from "../../stores/instances"
import { fetchSessions, getSessions, setActiveSessionFromList } from "../../stores/sessions"
import { getOpenCodeInstanceGeneration } from "../../stores/opencode-data"
import { tGlobal } from "../i18n"
import { invalidateBackgroundPush, refreshBackgroundPush, reportPushFocus, updateBackgroundPushScope } from "../background-push"
import { setShowFolderSelection } from "../../stores/ui"

export function useBackgroundPush() {
  if (!isWebHost()) return
  const [pending, setPending] = createSignal("")
  createEffect(() => { if (authRecovery.required()) invalidateBackgroundPush() })
  const opaque = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(value)
  onMount(() => {
    if (!("serviceWorker" in navigator)) return
    const fragment = /^#push=([A-Za-z0-9_-]{32,128})$/.exec(location.hash)
    if (fragment) {
      setPending(fragment[1])
      history.replaceState(null, "", location.pathname + location.search)
    }
    const message = (event: MessageEvent) => {
      if (event.source !== navigator.serviceWorker.controller || event.origin !== location.origin) return
      if (event.data?.v === 1 && event.data.type === "codenomad-push-route" && opaque(event.data.route)) setPending(event.data.route)
    }
    navigator.serviceWorker.addEventListener("message", message)
    const focus = () => void reportPushFocus(preferences().osNotificationsAllowWhenVisible)
    const hide = () => void reportPushFocus(true)
    const refresh = () => { void refreshBackgroundPush(); focus() }
    const timer = setInterval(focus, 10000)
    window.addEventListener("focus", refresh)
    window.addEventListener("blur", focus)
    window.addEventListener("pagehide", hide)
    document.addEventListener("visibilitychange", focus)
    navigator.serviceWorker.addEventListener("controllerchange", refresh)
    const off = authRecovery.onRestored(refresh)
    void refreshBackgroundPush()
    onCleanup(() => {
      clearInterval(timer); off()
      window.removeEventListener("focus", refresh); window.removeEventListener("blur", focus)
      window.removeEventListener("pagehide", hide)
      document.removeEventListener("visibilitychange", focus)
      navigator.serviceWorker.removeEventListener("message", message)
      navigator.serviceWorker.removeEventListener("controllerchange", refresh)
    })
  })
  createEffect(() => {
    const routing = preferences().notificationRouting
    const projects = appTabs().flatMap(tab => {
      const id = tab.kind === "instance" ? tab.instance.id : tab.kind === "remote-restore" ? tab.instanceId : undefined
      return id && parseInstanceKey(id).backendId === "local" && instances().has(id) ? [id] : []
    })
    updateBackgroundPushScope(projects, { v: 1, needsInput: routing.needsInput.system, sessionDone: routing.sessionDone.system },
      { v: 1, type: "codenomad-push-copy", needsInput: tGlobal("settings.notifications.push.needsInput"), sessionDone: tGlobal("settings.notifications.push.sessionDone") })
    void reportPushFocus(preferences().osNotificationsAllowWhenVisible)
  })
  createEffect(() => {
    const token = pending()
    if (!token || appSessionRestoreGateActive() || authRecovery.required()) return
    let cancelled = false
    const candidates: Array<{ id: string; waitingId?: string; current(): boolean }> = [
      ...appTabs().flatMap(tab => tab.kind === "remote-restore" && tab.instanceId
        ? [{ id: tab.instanceId, waitingId: tab.id, current: () => appTabs().includes(tab) }] : []),
      ...[...instances().values()].map(instance => {
        const id = instance.id, operation = captureBackendOperation(id), generation = getOpenCodeInstanceGeneration(id)
        return { id, current: () => operation.current() && instances().get(id)?.client === instance.client
          && getOpenCodeInstanceGeneration(id) === generation }
      }),
    ]
    // Resolve once after authenticated restoration; an absent target stays absent, never Retry.
    void (async () => {
      try {
        const response = await localHttp.fetch(localHttp.url(`/api/push/routes/${token}`), {
          credentials: "include", cache: "no-store", signal: AbortSignal.timeout(8000),
        })
        if (response.status === 401) return
        if (!response.ok) { setPending(""); return }
        const target = await response.json()
        if (cancelled || pending() !== token || !target || typeof target.instanceId !== "string" || typeof target.sessionId !== "string") return
        // The local core owns raw workspace IDs. Qualified targets require the remote producer's generation proof.
        if (target.backendId && target.backendId !== "local" || parseInstanceKey(target.instanceId).backendId !== "local") { setPending(""); return }
        const id = target.instanceId
        const candidate = candidates.find(candidate => candidate.id === id && candidate.current())
        // Initial inventory may still be arriving on a fresh page. Its publication
        // re-runs this effect; keep the intent without starting inventory recovery.
        if (!candidate) return
        if (candidate.waitingId) selectAppTab(candidate.waitingId)
        else {
          if (!getSessions(id).some(session => session.id === target.sessionId)) {
            await fetchSessions(id, { signal: captureBackendOperation(id).signal })
          }
          if (cancelled || !candidate.current() || pending() !== token
            || !getSessions(id).some(session => session.id === target.sessionId)) { setPending(""); return }
          selectInstanceTab(id)
          setActiveSessionFromList(id, target.sessionId)
        }
        setShowFolderSelection(false)
        setPending("")
      } catch { if (!cancelled) setPending("") }
    })()
    onCleanup(() => { cancelled = true })
  })
}
