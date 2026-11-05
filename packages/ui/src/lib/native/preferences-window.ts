import type { LocationRef } from "@opencode/client"
import { listen } from "@tauri-apps/api/event"
import { invoke } from "@tauri-apps/api/core"
import { isElectronHost, isTauriHost, runtimeEnv } from "../runtime-env"
import type { SettingsSectionId } from "../../stores/settings-screen"
import { getLogger } from "../logger"
import { isServerId } from "../project-identity"
import { normalizeOpenerStartupStateResult, type OpenerStartupStateResult, type StartupStateCommand } from "./startup-state-command"

const sections = new Set<SettingsSectionId>([
  "general", "chat", "hotkeys", "notifications", "speech", "remote", "opencode",
  "providers", "missions", "usage", "sidecars", "config-files", "advanced", "info",
])

export interface NativePreferencesRequest {
  section: SettingsSectionId
  scrollTop?: number
  instanceId?: string
  serverId?: string
  /** Opened project folder, separate from the selected native Location (WSL/worktrees). */
  workspacePath?: string
  location?: LocationRef
}

export function normalizeNativePreferencesRequest(value: unknown): NativePreferencesRequest | null {
  if (typeof value === "string") return sections.has(value as SettingsSectionId) ? { section: value as SettingsSectionId } : null
  if (!value || typeof value !== "object") return null
  const candidate = value as Record<string, unknown>
  if (Array.isArray(value) || Object.keys(candidate).some(key => !["section", "scrollTop", "instanceId", "serverId", "workspacePath", "location"].includes(key))) return null
  if (Object.prototype.hasOwnProperty.call(candidate, "serverId") && !isServerId(candidate.serverId)) return null
  if (!sections.has(candidate.section as SettingsSectionId)) return null
  const workspacePath = candidate.workspacePath
  if (workspacePath !== undefined && workspacePath !== null
    && (typeof workspacePath !== "string" || !workspacePath || workspacePath.length > 32768 || workspacePath.includes("\0"))) return null
  const location = candidate.location
  if (location !== undefined && location !== null) {
    if (typeof location !== "object" || Array.isArray(location)) return null
    const value = location as Record<string, unknown>
    if (Object.keys(value).some(key => !["directory", "workspaceID"].includes(key))
      || typeof value.directory !== "string" || !value.directory || value.directory.length > 32768 || value.directory.includes("\0")) return null
  }
  return {
    section: candidate.section as SettingsSectionId,
    ...(isServerId(candidate.serverId) ? { serverId: candidate.serverId } : {}),
    ...(Number.isSafeInteger(candidate.scrollTop) && (candidate.scrollTop as number) >= 0 && (candidate.scrollTop as number) <= 10_000_000 ? { scrollTop: candidate.scrollTop as number } : {}),
    ...(typeof candidate.instanceId === "string" && candidate.instanceId ? { instanceId: candidate.instanceId } : {}),
    ...(typeof workspacePath === "string" ? { workspacePath } : {}),
    ...(location && typeof location === "object" && typeof (location as LocationRef).directory === "string"
      ? { location: location as LocationRef }
      : {}),
  }
}

export function readPreferencesRequestFromUrl(url: string): NativePreferencesRequest | null {
  const params = new URL(url).searchParams
  for (const key of ["preferences", "preferencesServerId", "preferencesInstanceId", "preferencesWorkspacePath", "preferencesDirectory", "preferencesWorkspaceId"]) {
    if (params.getAll(key).length > 1) return null
  }
  const section = params.get("preferences")
  if (!section || !sections.has(section as SettingsSectionId)) return null
  const instanceId = params.get("preferencesInstanceId") || undefined
  const workspacePath = params.get("preferencesWorkspacePath")
  const directory = params.get("preferencesDirectory")
  const workspaceID = params.get("preferencesWorkspaceId") || undefined
  if (workspaceID && directory === null) return null
  return normalizeNativePreferencesRequest({
    section: section as SettingsSectionId,
    ...(params.has("preferencesServerId") ? { serverId: params.get("preferencesServerId") } : {}),
    ...(instanceId ? { instanceId } : {}),
    ...(workspacePath !== null ? { workspacePath } : {}),
    ...(directory !== null ? { location: { directory, ...(workspaceID ? { workspaceID } : {}) } } : {}),
  })
}

export async function openNativePreferences(request: NativePreferencesRequest, toggle = false, resume = false): Promise<void> {
  if (runtimeEnv.host === "electron") {
    const open = window.electronAPI?.openPreferences
    if (!open) throw new Error("Native Preferences is unavailable")
    await open(request.section, { ...(request.serverId !== undefined ? { serverId: request.serverId } : {}), instanceId: request.instanceId, workspacePath: request.workspacePath, location: request.location }, toggle, resume)
    return
  }
  if (runtimeEnv.host === "tauri") {
    await invoke("open_preferences_window", { request, toggle, resume })
    return
  }
  throw new Error("Native Preferences is unavailable")
}

export async function markNativePreferencesReady(): Promise<void> {
  if (isElectronHost()) {
    await window.electronAPI?.preferencesReady?.()
  } else if (isTauriHost()) {
    await invoke("preferences_window_ready")
  }
}

export async function acceptNativePreferencesRequest(request: NativePreferencesRequest, generation?: number): Promise<void> {
  if (isElectronHost()) {
    await window.electronAPI?.acceptPreferencesRequest?.(request)
  } else if (isTauriHost()) {
    await invoke("preferences_accept_request", { request, generation })
  }
}

export async function onNativePreferencesFlushRequested(flush: (generation?: number) => Promise<void>): Promise<() => void> {
  if (isElectronHost()) {
    window.__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__ = flush
    return () => {
      if (window.__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__ === flush) {
        delete window.__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__
      }
    }
  }
  if (isTauriHost()) {
    return listen<{ generation: number }>("client-state:flush-requested", event => {
      void flush(event.payload.generation).catch(error => getLogger("actions").warn("Preferences shutdown flush failed", error))
    })
  }
  return () => undefined
}

export async function getNativePreferencesRequest(): Promise<NativePreferencesRequest> {
  const fromUrl = readPreferencesRequestFromUrl(window.location.href)
  if (isElectronHost()) {
    const api = window.electronAPI
    const value = api?.getPreferencesRequest
      ? await api.getPreferencesRequest()
      : await api?.getPreferencesSection?.()
    return normalizeNativePreferencesRequest(value) ?? fromUrl ?? { section: "general" }
  }
  if (isTauriHost()) {
    const value = await invoke<unknown>("preferences_get_request")
    return normalizeNativePreferencesRequest(value) ?? fromUrl ?? { section: "general" }
  }
  return fromUrl ?? { section: "general" }
}

export async function onNativePreferencesRequest(callback: (request: NativePreferencesRequest) => void): Promise<() => void> {
  if (isElectronHost()) {
    return window.electronAPI?.onPreferencesSection?.((value) => {
      const request = normalizeNativePreferencesRequest(value)
      if (request) callback(request)
    }) ?? (() => undefined)
  }
  if (isTauriHost()) {
    return await listen<unknown>("preferences:section", (event) => {
      const request = normalizeNativePreferencesRequest(event.payload)
      if (request) callback(request)
    })
  }
  return () => undefined
}

export async function onNativePreferencesCloseRequested(callback: () => void): Promise<() => void> {
  if (isElectronHost()) return window.electronAPI?.onPreferencesCloseRequested?.(callback) ?? (() => undefined)
  if (isTauriHost()) return await listen("preferences:close-requested", callback)
  return () => undefined
}

export async function onNativePreferencesTransitionRequested(callback: (id: number) => void): Promise<() => void> {
  const handle = (value: unknown) => {
    if (value && typeof value === "object" && Number.isSafeInteger((value as { id?: unknown }).id)) {
      callback((value as { id: number }).id)
    }
  }
  if (isElectronHost()) return window.electronAPI?.onPreferencesTransitionRequested?.(handle) ?? (() => undefined)
  if (isTauriHost()) return await listen<unknown>("preferences:transition-requested", (event) => handle(event.payload))
  return () => undefined
}

/**
 * Reads or changes startup state of the local window that opened Preferences.
 * The host resolves that window itself; `epoch` fences mutations against a
 * newer opener so a change never lands on a window the user did not see.
 */
export async function requestOpenerStartupState(command: StartupStateCommand, epoch?: number): Promise<OpenerStartupStateResult> {
  let value: unknown
  if (isElectronHost()) {
    const request = window.electronAPI?.openerStartupState
    if (!request) throw new Error("Opener startup state is unavailable")
    value = await request(command, epoch)
  } else if (isTauriHost()) {
    value = await invoke<unknown>("preferences_opener_startup_state", { command, epoch: epoch ?? null })
  } else {
    throw new Error("Opener startup state is unavailable")
  }
  const result = normalizeOpenerStartupStateResult(value)
  if (!result) throw new Error("Invalid opener startup state")
  return result
}

export async function resolveNativePreferencesTransition(id: number, approved: boolean): Promise<void> {
  if (isElectronHost()) {
    await window.electronAPI?.resolvePreferencesTransition?.(id, approved)
  } else if (isTauriHost()) {
    await invoke("preferences_resolve_transition", { id, approved })
  }
}
