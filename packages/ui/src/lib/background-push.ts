import { createSignal } from "solid-js"
import { localHttp } from "./auth-recovery"
import { isWebHost } from "./runtime-env"
import { generateUUID } from "./client-identity"
import { backgroundPushActive, setBackgroundPushActive, setBackgroundPushProjects } from "./background-push-state"

export type PushState = "ready" | "disabled" | "storage" | "unavailable" | "https" | "ios" | "denied"
export const [backgroundPushState, setState] = createSignal<PushState>("unavailable")
export const [backgroundPushBusy, setBusy] = createSignal(false)
let subscription: PushSubscription | null = null
let generation = 0
// ponytail: one window's project snapshot; aggregate live browser-window scopes for multi-window device delivery.
let scope = { projects: [] as string[], preferences: { v: 1 as const, needsInput: false, sessionDone: false } }
let copy = { v: 1, type: "codenomad-push-copy", needsInput: "", sessionDone: "" }
let lane = Promise.resolve()
let viewId: string | undefined

export function invalidateBackgroundPush() {
  generation++
  setBackgroundPushActive(false)
}

export function pushEnvironment(): PushState {
  if (!isWebHost()) return "unavailable"
  if (!window.isSecureContext || location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") return "https"
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1
  if (ios && !matchMedia("(display-mode: standalone)").matches && !(navigator as Navigator & { standalone?: boolean }).standalone) return "ios"
  if (!("serviceWorker" in navigator) || typeof PushManager !== "function" || typeof Notification !== "function") return "unavailable"
  return Notification.permission === "denied" ? "denied" : "ready"
}

async function request(path: string, method = "GET", body?: unknown) {
  const response = await localHttp.fetch(localHttp.url(`/api/push/${path}`), {
    method, cache: "no-store", credentials: "include", signal: AbortSignal.timeout(8000),
    keepalive: path === "focus",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  })
  if (!response.ok) throw new Error("Push unavailable")
  return response.status === 204 ? undefined : response.json()
}

async function registration() {
  const reg = await navigator.serviceWorker.getRegistration("/")
  if (!reg || new URL(reg.scope).origin !== location.origin || new URL(reg.scope).pathname !== "/"
    || !reg.active || new URL(reg.active.scriptURL).pathname !== "/sw.js") throw new Error("UI worker unavailable")
  reg.active.postMessage(copy)
  return reg
}

export async function refreshBackgroundPush() {
  if (backgroundPushBusy()) return
  const current = ++generation
  const state = pushEnvironment()
  setState(state)
  if (state !== "ready") { setBackgroundPushActive(false); return }
  try {
    const status = await request("status")
    if (current !== generation) return
    if (!status.enabled) {
      setState(status.unavailable ? "storage" : "disabled")
      setBackgroundPushActive(false)
      return
    }
    const sub = await (await registration()).pushManager.getSubscription()
    if (current !== generation) return
    subscription = sub
    setState("ready")
    setBackgroundPushActive(status.enabled === true && status.subscribed === true && Boolean(sub))
    if (backgroundPushActive()) syncBackgroundPush()
  } catch {
    if (current === generation) { setState("unavailable"); setBackgroundPushActive(false) }
  }
}

export async function toggleBackgroundPush(enabled: boolean) {
  if (backgroundPushBusy()) return
  setBusy(true)
  const current = ++generation
  try {
    if (!enabled) {
      // Remove host consent first: a failed request leaves the control available for retry.
      await lane.catch(() => {})
      await request("subscription", "DELETE")
      setBackgroundPushActive(false)
      await subscription?.unsubscribe()
      subscription = null
      return
    }
    if (pushEnvironment() !== "ready") return
    // This call stays in the explicit activation gesture (before any asynchronous IO).
    const permission = await Notification.requestPermission()
    if (current !== generation) return
    if (permission !== "granted") { setState(permission === "denied" ? "denied" : "ready"); return }
    const { publicKey } = await request("subscription", "PUT", { consent: true })
    if (current !== generation) return
    const reg = await registration()
    if (current !== generation) return
    const key = Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0))
    const existing = await reg.pushManager.getSubscription()
    if (current !== generation) return
    subscription = existing ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
    if (current !== generation) return
    const subscribedScope = scope
    await request("subscription", "PUT", { subscription: subscription.toJSON(), ...subscribedScope })
    if (current === generation) {
      setBackgroundPushProjects(subscribedScope.projects)
      setState("ready"); setBackgroundPushActive(true)
    }
  } catch { if (current === generation) setState("unavailable") }
  finally { setBusy(false) }
}

export function updateBackgroundPushScope(projects: string[], preferences: typeof scope.preferences, localized: typeof copy) {
  scope = { projects, preferences }
  copy = localized
  syncBackgroundPush()
}
function syncBackgroundPush() {
  if (backgroundPushBusy() || !backgroundPushActive() || !subscription) return
  const snapshot = scope, body = { subscription: subscription.toJSON(), ...snapshot }, current = generation
  lane = lane.catch(() => {}).then(async () => {
    if (current !== generation || !backgroundPushActive() || snapshot !== scope) return
    await registration()
    if (current !== generation || !backgroundPushActive()) return
    await request("subscription", "PUT", body)
    if (current === generation) setBackgroundPushProjects(body.projects)
  }).catch(() => { if (current === generation) setState("unavailable") })
}
export async function reportPushFocus(allowWhenVisible = false) {
  if (!backgroundPushActive() || !subscription) return
  try {
    await request("focus", "PUT", { endpoint: subscription.endpoint, viewId: viewId ??= generateUUID(),
      focused: !allowWhenVisible && document.visibilityState === "visible" && document.hasFocus() })
  } catch { /* A lost hint expires on the host; consent and delivery stay independent. */ }
}
