import path from "node:path"
import type { BrowserWindow, IpcMainInvokeEvent, OpenDialogOptions, OpenDialogReturnValue } from "electron"

interface IPCRegistrar {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => any): void
}

interface DialogIPCDependencies {
  /** The validated local or Preferences window of the request; throws for any other sender. */
  resolveWindow(event: IpcMainInvokeEvent): BrowserWindow
  showOpenDialog(window: BrowserWindow, options: OpenDialogOptions): Promise<OpenDialogReturnValue>
}

interface DialogOpenRequest {
  mode: "directory" | "file"
  title?: string
  defaultPath?: string
  filters?: Array<{ name?: string; extensions: string[] }>
  multiple?: boolean
}

interface DialogOpenResult {
  canceled: boolean
  paths: string[]
}

/** The native open dialog. A request without a default path starts in the folder of this process's last selection. */
export function setupDialogIPC(ipcMain: IPCRegistrar, dependencies: DialogIPCDependencies): void {
  // Electron opens a dialog without a default path in Downloads.
  let lastDirectory: string | undefined
  ipcMain.handle("dialog:open", async (event, request: DialogOpenRequest): Promise<DialogOpenResult> => {
    const window = dependencies.resolveWindow(event)
    if (!request || (request.mode !== "directory" && request.mode !== "file")) throw new Error("Invalid dialog request")
    const properties: OpenDialogOptions["properties"] = request.mode === "directory" ? ["openDirectory", "createDirectory"] : ["openFile"]
    if (request.mode === "file" && request.multiple) properties.push("multiSelections")
    const result = await dependencies.showOpenDialog(window, {
      title: request.title,
      defaultPath: request.defaultPath || lastDirectory,
      properties,
      filters: request.filters?.map((filter) => ({ name: filter.name ?? "Files", extensions: filter.extensions })),
    })
    if (!result.canceled && result.filePaths[0]) lastDirectory = path.dirname(result.filePaths[0])
    return { canceled: result.canceled, paths: result.filePaths }
  })
}
