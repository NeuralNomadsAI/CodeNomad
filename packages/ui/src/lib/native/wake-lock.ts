import { invoke } from "@tauri-apps/api/core"
import { isElectronHost, isTauriHost } from "../runtime-env"
import { getLogger } from "../logger"

const log = getLogger("actions")

let desired = false
let inFlight: Promise<boolean> | null = null

let applied = false

/**
 * Detect if we're running on Wayland.
 * Electron on Wayland has a critical bug where screen lock causes system hang (Issue #441).
 */
async function isWaylandSession(): Promise<boolean> {
  if (typeof window === "undefined") return false
  
  // Electron exposes platform info through getPlatformInfo
  const api = (window as any).electronAPI
  if (api?.getPlatformInfo) {
    try {
      const platformInfo = await api.getPlatformInfo()
      // Check XDG_SESSION_TYPE environment variable
      if (platformInfo?.sessionType === "wayland") {
        return true
      }
    } catch (error) {
      log.log("[wake-lock] Failed to get platform info", error)
    }
  }
  
  // Fallback: check user agent for Wayland hints
  if (typeof navigator !== "undefined") {
    const ua = navigator.userAgent.toLowerCase()
    // Electron on Wayland often includes "wayland" in user agent
    if (ua.includes("wayland")) {
      return true
    }
  }
  
  return false
}

// Cache Wayland detection result to avoid repeated async calls
let waylandDetectionCache: Promise<boolean> | null = null
function getWaylandDetection(): Promise<boolean> {
  if (waylandDetectionCache === null) {
    waylandDetectionCache = isWaylandSession()
  }
  return waylandDetectionCache
}

async function hasAnyWakeLockSupport(): Promise<boolean> {
  if (typeof window === "undefined") return false
  
  // CRITICAL: Disable wake-lock on Electron + Wayland due to screen lock crash (Issue #441)
  // When user locks screen while wake-lock is active, system hangs and requires hard reboot
  if (isElectronHost()) {
    const isWayland = await getWaylandDetection()
    if (isWayland) {
      log.log(
        "[wake-lock] Disabled on Wayland due to critical screen lock crash (Issue #441). " +
        "Use X11 session for wake-lock support, or use Tauri build instead."
      )
      return false
    }
    
    const api = (window as any).electronAPI
    if (api?.setWakeLock) return true
  }
  if (isTauriHost()) {
    return typeof window.__TAURI__?.core?.invoke === "function"
  }
  return false
}

async function setElectronWakeLock(enabled: boolean): Promise<boolean> {
  const api = (window as typeof window & { electronAPI?: { setWakeLock?: (enabled: boolean) => Promise<{ enabled: boolean }> } })
    .electronAPI
  if (!api?.setWakeLock) {
    return false
  }

  try {
    const result = await api.setWakeLock(Boolean(enabled))
    return Boolean(result?.enabled)
  } catch (error) {
    log.log("[wake-lock] electron wake lock failed", error)
    return false
  }
}

async function setTauriWakeLock(enabled: boolean): Promise<boolean> {
  try {
    const hasSupport = await hasAnyWakeLockSupport()
    if (!hasSupport) {
      return false
    }

    if (enabled) {
      await invoke("wake_lock_start", { config: { display: false, idle: true, sleep: false } })
      return true
    }

    await invoke("wake_lock_stop")
    return false
  } catch (error) {
    log.log("[wake-lock] tauri wake lock failed", error)
    return false
  }
}

async function applyWakeLock(enabled: boolean): Promise<boolean> {
  if (typeof window === "undefined") return false

  if (isElectronHost()) {
    const ok = await setElectronWakeLock(enabled)
    return ok
  }

  if (isTauriHost()) {
    const ok = await setTauriWakeLock(enabled)
    return ok
  }

  return false
}

export function setWakeLockDesired(nextDesired: boolean): Promise<boolean> {
  desired = Boolean(nextDesired)

  if (inFlight) {
    // Coalesce: once the current request resolves, it will re-apply the latest desired state.
    return inFlight
  }

  const target = desired

  inFlight = (async () => {
    try {
      const ok = await applyWakeLock(target)
      applied = target ? ok : false
      return ok
    } finally {
      inFlight = null
      // If desired changed while in-flight, re-apply once.
      if (desired !== target) {
        void setWakeLockDesired(desired)
      }

      // If we tried to enable but there is no support, avoid re-trying forever.
      if (desired) {
        const hasSupport = await hasAnyWakeLockSupport()
        if (!hasSupport) {
          applied = false
        }
      }
    }
  })()

  return inFlight!
}
