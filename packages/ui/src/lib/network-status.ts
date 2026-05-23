import { createSignal } from "solid-js"
import { serverEvents } from "./server-events"
import { debugInfo } from "../stores/debug-log"

const [isOnline, setIsOnline] = createSignal(typeof navigator !== "undefined" ? navigator.onLine : true)

const restoreListeners: Array<() => void> = []

function onOnline() {
  debugInfo("network", "Browser came online")
  setIsOnline(true)
  serverEvents.resetRetry()
  restoreListeners.forEach((fn) => fn())
}

function onOffline() {
  debugInfo("network", "Browser went offline")
  setIsOnline(false)
}

let initialized = false
function initNetworkStatus() {
  if (initialized || typeof window === "undefined") return
  initialized = true
  window.addEventListener("online", onOnline)
  window.addEventListener("offline", onOffline)
}

initNetworkStatus()

export function isOnlineSignal(): () => boolean {
  return isOnline
}

export function onNetworkRestored(fn: () => void): () => void {
  restoreListeners.push(fn)
  return () => {
    const idx = restoreListeners.indexOf(fn)
    if (idx !== -1) restoreListeners.splice(idx, 1)
  }
}
