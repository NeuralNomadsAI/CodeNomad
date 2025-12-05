import { getLogger } from "./logger"

export type HostRuntime = "electron" | "tauri" | "web"
export type PlatformKind = "desktop" | "mobile"

export interface RuntimeEnvironment {
  host: HostRuntime
  platform: PlatformKind
}

declare global {
  interface Window {
    electronAPI?: unknown
    __TAURI__?: {
      invoke?: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>
      event?: {
        listen: (event: string, handler: (payload: { payload: unknown }) => void) => Promise<() => void>
      }
      dialog?: {
        open?: (options: Record<string, unknown>) => Promise<string | string[] | null>
        save?: (options: Record<string, unknown>) => Promise<string | null>
      }
    }
  }
}

function detectHost(): HostRuntime {
  if (typeof window === "undefined") {
    return "web"
  }

  const win = window as Window & { electronAPI?: unknown }
  if (typeof win.electronAPI !== "undefined") {
    return "electron"
  }

  if (typeof win.__TAURI__ !== "undefined") {
    return "tauri"
  }

  if (typeof navigator !== "undefined" && /tauri/i.test(navigator.userAgent)) {
    return "tauri"
  }

  return "web"
}

function detectPlatform(): PlatformKind {
  if (typeof navigator === "undefined") {
    return "desktop"
  }

  const uaData = (navigator as any).userAgentData
  if (uaData?.mobile) {
    return "mobile"
  }

  const ua = navigator.userAgent.toLowerCase()
  if (/android|iphone|ipad|ipod|blackberry|mini|windows phone|mobile|silk/.test(ua)) {
    return "mobile"
  }

  return "desktop"
}

const log = getLogger("actions")

let cachedEnv: RuntimeEnvironment | null = null

export function detectRuntimeEnvironment(): RuntimeEnvironment {
  if (cachedEnv) {
    return cachedEnv
  }
  cachedEnv = {
    host: detectHost(),
    platform: detectPlatform(),
  }
  if (typeof window !== "undefined") {
    log.info(`[runtime] host=${cachedEnv.host} platform=${cachedEnv.platform}`)
  }
  return cachedEnv
}

export const runtimeEnv = detectRuntimeEnvironment()

export const isElectronHost = () => runtimeEnv.host === "electron"
export const isTauriHost = () => runtimeEnv.host === "tauri"
export const isWebHost = () => runtimeEnv.host === "web"
export const isMobilePlatform = () => runtimeEnv.platform === "mobile"
