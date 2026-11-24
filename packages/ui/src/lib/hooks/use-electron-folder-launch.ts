import { onCleanup, onMount } from "solid-js"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { getLogger } from "../logger"
import { isElectronHost, isTauriHost } from "../runtime-env"

export interface DesktopFolderLaunchAPI {
  nextPendingFolder?: () => Promise<string | null>
  acknowledgePendingFolder?: (folder: string, opened: boolean) => Promise<unknown>
  onPendingFolders?: (callback: () => void) => () => void
}

export function installElectronFolderLaunchHandler(
  api: DesktopFolderLaunchAPI | undefined,
  openFolder: (path: string) => boolean | void | Promise<boolean | void>,
  reportError: (error: unknown) => void,
): () => void {
  if (!api?.nextPendingFolder || !api.acknowledgePendingFolder || !api.onPendingFolders) return () => {}
  let disposed = false
  let draining = false
  let drainAgain = false
  const drain = async () => {
    if (draining) { drainAgain = true; return }
    draining = true
    try {
      do {
        drainAgain = false
        while (!disposed) {
          const folder = await api.nextPendingFolder!()
          if (!folder) break
          try {
            const opened = (await openFolder(folder)) !== false
            await api.acknowledgePendingFolder!(folder, opened)
          } catch (error) {
            await api.acknowledgePendingFolder!(folder, false).catch(() => {})
            reportError(error)
          }
        }
      } while (drainAgain && !disposed)
    } catch (error) { reportError(error) } finally {
      draining = false
    }
  }
  const unsubscribe = api.onPendingFolders(() => { void drain() })
  void drain()
  return () => { disposed = true; unsubscribe() }
}

export const installDesktopFolderLaunchHandler = installElectronFolderLaunchHandler

export function useDesktopFolderLaunch(openFolder: (path: string) => boolean | void | Promise<boolean | void>): void {
  const log = getLogger("actions")
  onMount(() => {
    const reportError = (error: unknown) => log.error("Failed to open launched folder", error)
    if (isElectronHost()) {
      onCleanup(installDesktopFolderLaunchHandler(window.electronAPI, openFolder, reportError))
      return
    }
    if (!isTauriHost()) return
    let disposed = false
    let cleanup = () => {}
    void (async () => {
      let notify = () => {}
      const unlisten = await listen("desktop:folders-pending", () => notify())
      if (disposed) { unlisten(); return }
      cleanup = installDesktopFolderLaunchHandler({
        nextPendingFolder: () => invoke<string | null>("desktop_launch_next_folder"),
        acknowledgePendingFolder: (folder, opened) => invoke("desktop_launch_acknowledge_folder", { folder, opened }),
        onPendingFolders: (callback) => { notify = callback; return () => { notify = () => {} } },
      }, openFolder, reportError)
      await invoke("desktop_launch_ready")
      if (disposed) { cleanup(); unlisten(); return }
      const previous = cleanup
      cleanup = () => { previous(); unlisten() }
    })().catch(reportError)
    onCleanup(() => { disposed = true; cleanup() })
  })
}

export const useElectronFolderLaunch = useDesktopFolderLaunch
