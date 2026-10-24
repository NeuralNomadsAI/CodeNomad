import type { BrowserWindow, IpcMainInvokeEvent } from "electron"
import { validateMainFrame } from "./ipc-security"
import {
  deleteOtherProfiles, listOtherProfiles, requireProfileIds, setNextLaunchProfile,
  type CurrentProfile, type ProfileRoots,
} from "./data-profile-cleanup"

interface IPCRegistrar {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => any): void
}

interface DataProfileCleanupIPCDependencies {
  /** Local application windows and the Preferences window; remote windows never qualify. */
  resolveWindow(sender: IpcMainInvokeEvent["sender"]): BrowserWindow | undefined
  getAllowedOrigins(window: BrowserWindow): string[]
  roots(): ProfileRoots
  current(): CurrentProfile
  /** The graceful relaunch; the new process resolves its profile normally. */
  relaunch(): void
  operations?: Pick<typeof import("./data-profile-cleanup"), "listOtherProfiles" | "deleteOtherProfiles" | "setNextLaunchProfile">
}

/**
 * Fixed host operations: list the data profiles, delete IDs from such a listing, remember the
 * profile the next launch opens and relaunch into it. The renderer never supplies a path; the host
 * re-enumerates and re-validates before deleting and validates a chosen name itself. Operations run
 * one at a time so a listing never observes a half-finished deletion and a relaunch follows the
 * choice made before it.
 */
export function setupDataProfileCleanupIPC(ipcMain: IPCRegistrar, dependencies: DataProfileCleanupIPCDependencies): void {
  const operations = dependencies.operations ?? { listOtherProfiles, deleteOtherProfiles, setNextLaunchProfile }
  let queue: Promise<unknown> = Promise.resolve()
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation, operation)
    queue = next.catch(() => undefined)
    return next
  }
  const authorize = (event: IpcMainInvokeEvent) => {
    const window = dependencies.resolveWindow(event.sender)
    if (!window) throw new Error("Data profiles are limited to local application windows")
    validateMainFrame(event, window, dependencies.getAllowedOrigins(window))
  }
  ipcMain.handle("data-profiles:listOthers", (event) => {
    authorize(event)
    return serialized(() => operations.listOtherProfiles(dependencies.roots(), dependencies.current()))
  })
  ipcMain.handle("data-profiles:deleteOthers", (event, ids: unknown) => {
    authorize(event)
    const requested = requireProfileIds(ids)
    return serialized(() => operations.deleteOtherProfiles(dependencies.roots(), dependencies.current(), requested))
  })
  ipcMain.handle("data-profiles:setNextLaunch", (event, name: unknown) => {
    authorize(event)
    return serialized(() => operations.setNextLaunchProfile(dependencies.roots(), dependencies.current(), name))
  })
  ipcMain.handle("data-profiles:relaunch", (event) => {
    authorize(event)
    return serialized(async () => { dependencies.relaunch() })
  })
}
