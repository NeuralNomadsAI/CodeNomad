import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { detectRuntimeEnvironment, type RuntimeEnvironment } from "../runtime-env"
import { isEmbeddedProjectView } from "../embed-mode"
import { nativeBrowserHost, physicalBrowserBounds, type BrowserTargetBounds } from "./browser"

/**
 * A remote CodeNomad page shown inside a local window's tab, with the storage of
 * that server's remote window and the remote windows' native access only.
 */
export interface RemoteViewOpenPayload {
  viewId: string
  profileId: string
  baseUrl: string
  url: string
  cookie?: {
    origin: string
    name: string
    value: string
    path: string
    secure: boolean
    httpOnly: boolean
    sameSite: "lax" | "strict" | "none"
    expires?: number
  }
}

export interface RemoteViewUpdate {
  viewId: string
  url: string
  title: string
}

/**
 * Local desktop windows host remote project tabs (Electron; Tauri on Windows, as
 * browser previews). Never the web host, a Remote Control device, a remote window
 * or an embedded page: a remote tab never opens another server.
 */
export function remoteViewHost(
  environment: Pick<RuntimeEnvironment, "host" | "windowContext"> = detectRuntimeEnvironment(),
  userAgent?: string,
): "electron" | "tauri" | undefined {
  if (isEmbeddedProjectView()) return undefined
  return nativeBrowserHost(environment, userAgent)
}

export const canOpenRemoteProjectTabs = () => remoteViewHost() !== undefined

/** Electron places views in window coordinates (DIP); Tauri in physical pixels. */
function viewBounds(rect: Pick<DOMRect, "x" | "y" | "width" | "height">): BrowserTargetBounds {
  if (remoteViewHost() === "tauri") return physicalBrowserBounds(rect, window.devicePixelRatio)
  return physicalBrowserBounds(rect, 1)
}

export async function openRemoteView(payload: RemoteViewOpenPayload, rect: DOMRect): Promise<void> {
  const bounds = viewBounds(rect)
  if (remoteViewHost() === "electron") return window.electronAPI!.openRemoteView!({ ...payload, bounds })
  await invoke("remote_view_open", { payload: { ...payload, bounds } })
}

/** Without `rect` the view is hidden. */
export async function updateRemoteView(viewId: string, rect: DOMRect | null): Promise<void> {
  const bounds = rect ? viewBounds(rect) : undefined
  if (remoteViewHost() === "electron") return window.electronAPI!.updateRemoteView!({ viewId, bounds, visible: Boolean(rect) })
  await invoke("remote_view_update", { payload: { viewId, bounds, visible: Boolean(rect) } })
}

export async function closeRemoteView(viewId: string): Promise<void> {
  if (remoteViewHost() === "electron") return window.electronAPI!.closeRemoteView!(viewId)
  await invoke("remote_view_close", { viewId })
}

export async function onRemoteViewUpdated(callback: (update: RemoteViewUpdate) => void): Promise<() => void> {
  if (remoteViewHost() === "electron") return window.electronAPI!.onRemoteViewUpdated!(callback)
  return listen<RemoteViewUpdate>("remote-view:updated", (event) => callback(event.payload))
}
