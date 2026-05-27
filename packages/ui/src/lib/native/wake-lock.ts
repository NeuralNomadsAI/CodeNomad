import { invoke } from "@tauri-apps/api/core"
import { isElectronHost, isTauriHost } from "../runtime-env"
import { getLogger } from "../logger"

const log = getLogger("actions")

let desired = false
let inFlight: Promise<boolean> | null = null

let applied = false

function hasAnyWakeLockSupport(): boolean {
  if (typeof window === "undefined") return false
  if (isElectronHost()) {
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
    if (!hasAnyWakeLockSupport()) {
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
      if (desired && !hasAnyWakeLockSupport()) {
        applied = false
      }
    }
  })()

  return inFlight!
}
