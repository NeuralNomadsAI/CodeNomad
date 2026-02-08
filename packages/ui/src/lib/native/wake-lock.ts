import { runtimeEnv } from "../runtime-env"
import { getLogger } from "../logger"

const log = getLogger("actions")

let desired = false
let inFlight: Promise<boolean> | null = null

let applied = false

let webWakeLock: any = null

async function setWebWakeLock(enabled: boolean): Promise<boolean> {
  if (typeof navigator === "undefined") return false

  const api = (navigator as any).wakeLock
  if (!api?.request) {
    return false
  }

  try {
    if (enabled) {
      if (webWakeLock) {
        return true
      }
      webWakeLock = await api.request("screen")
      try {
        webWakeLock.addEventListener?.("release", () => {
          // If the lock is released by the UA (e.g., tab hidden), clear local state.
          webWakeLock = null
          if (desired) {
            // Re-acquire best-effort.
            queueMicrotask(() => {
              void setWakeLockDesired(true)
            })
          }
        })
      } catch {
        // optional
      }
      return true
    }

    if (webWakeLock) {
      await webWakeLock.release?.()
    }
    webWakeLock = null
    return false
  } catch (error) {
    log.log("[wake-lock] web wake lock failed", error)
    webWakeLock = null
    return false
  }
}

function hasAnyWakeLockSupport(): boolean {
  if (typeof window === "undefined") return false
  if (runtimeEnv.host === "electron") {
    const api = (window as any).electronAPI
    if (api?.setWakeLock) return true
  }
  if (runtimeEnv.host === "tauri") {
    // We'll attempt dynamic import; treat as potentially supported.
    return true
  }
  return Boolean((navigator as any)?.wakeLock?.request)
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
    const mod = await import("tauri-plugin-keepawake-api")
    const start = (mod as any).start as ((config?: any) => Promise<void>) | undefined
    const stop = (mod as any).stop as (() => Promise<void>) | undefined
    if (!start || !stop) {
      return false
    }

    if (enabled) {
      // Plugin config supports toggling display/idle/sleep. Use a conservative
      // default to keep both system + display awake.
      await start({ display: true, idle: true, sleep: true })
      return true
    }

    await stop()
    return false
  } catch (error) {
    log.log("[wake-lock] tauri wake lock failed", error)
    return false
  }
}

async function applyWakeLock(enabled: boolean): Promise<boolean> {
  if (typeof window === "undefined") return false

  if (runtimeEnv.host === "electron") {
    const ok = await setElectronWakeLock(enabled)
    if (ok || !enabled) return ok
    // fallback to web API if electron preload didn't expose it
  }

  if (runtimeEnv.host === "tauri") {
    const ok = await setTauriWakeLock(enabled)
    if (ok || !enabled) return ok
    // fallback to web API if tauri command isn't available
  }

  return await setWebWakeLock(enabled)
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
      // Treat disable attempts as applied even if the underlying API doesn't exist.
      applied = target
      return ok
    } finally {
      inFlight = null
      // If desired changed while in-flight, re-apply once.
      if (desired !== applied) {
        void setWakeLockDesired(desired)
      }

      // If we tried to enable but there is no support, avoid re-trying forever.
      if (desired && !hasAnyWakeLockSupport()) {
        applied = false
      }
    }
  })()

  return inFlight!
}
