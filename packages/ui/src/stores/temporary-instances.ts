import { createMemo, createSignal } from "solid-js"
import { serverApi } from "../lib/api-client"
import { tGlobal } from "../lib/i18n"
import { getLogger } from "../lib/logger"
import { serverEvents } from "../lib/server-events"
import { showAlertDialog, showChoiceDialog } from "./alerts"
import { closeInstanceTab } from "./app-tabs"
import { createInstance, instances, updateInstance } from "./instances"
import { addNamedRecentFolder } from "./preferences"

const log = getLogger("api")

// Server-side codes from routes/temporary-workspaces.ts.
const ERROR_KEYS: Record<string, string> = {
  temporary_running: "temporaryInstance.error.running",
  temporary_open_elsewhere: "temporaryInstance.error.openElsewhere",
  temporary_not_temporary: "temporaryInstance.error.notTemporary",
  temporary_not_found: "temporaryInstance.error.notTemporary",
}

function showFailure(titleKey: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  showAlertDialog(ERROR_KEYS[message] ? tGlobal(ERROR_KEYS[message]) : message, {
    title: tGlobal(titleKey),
    variant: "error",
  })
}

/** Every folder the server still treats as temporary, open in a tab or not. */
const [temporaryFolders, setTemporaryFolders] = createSignal<string[]>([])
let foldersRequested = false

function applyTemporaryFolders(folders: string[]) {
  setTemporaryFolders(folders)
  // A kept folder leaves the registry; every window drops its temporary mark.
  const registered = new Set(folders)
  for (const instance of instances().values()) {
    if (instance.temporary && !registered.has(instance.folder)) updateInstance(instance.id, { temporary: false })
  }
}

serverEvents.on("workspace.temporaryChanged", (event) => {
  if (event.type === "workspace.temporaryChanged") applyTemporaryFolders(event.folders)
})

export function ensureTemporaryFoldersLoaded(): void {
  if (foldersRequested) return
  foldersRequested = true
  serverApi.listTemporaryFolders()
    .then(({ folders }) => applyTemporaryFolders(folders))
    .catch((error) => {
      foldersRequested = false
      log.warn("Failed to list temporary folders", error)
    })
}

/**
 * Temporary folders no tab shows, e.g. after a stop, a disconnection or a
 * partly failed discard. The home page offers to resume them.
 */
export const leftoverTemporaryFolders = createMemo(() => {
  const open = new Set(Array.from(instances().values(), (instance) => instance.folder))
  return temporaryFolders().filter((folder) => !open.has(folder))
})

function temporaryName(date: Date): string {
  const time = date.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
  return tGlobal("temporaryInstance.name", { time })
}

/** Folder names start with their UTC creation stamp, `YYYYMMDD-HHMMSS-<id>`. */
export function temporaryFolderLabel(folder: string): string {
  const name = folder.split(/[\\/]/).pop() ?? folder
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(name)
  if (!match) return name
  const [, year, month, day, hour, minute, second] = match
  return temporaryName(new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute, +second)))
}

/** Opens a new tab on an empty CodeNomad-managed folder, outside the recent projects. */
export async function openTemporaryInstance(): Promise<string> {
  const { path } = await serverApi.createTemporaryFolder()
  try {
    const { instanceId } = await createInstance(path, temporaryName(new Date()))
    return instanceId
  } catch (error) {
    // Never leave an empty registered folder behind a failed launch.
    await serverApi.abandonTemporaryFolder(path).catch((cleanupError) => log.warn("Failed to remove unused temporary folder", cleanupError))
    throw error
  }
}

/** Reopens a leftover temporary folder; closing it asks to keep or discard again. */
export async function resumeTemporaryInstance(folder: string): Promise<string> {
  const { instanceId } = await createInstance(folder, temporaryFolderLabel(folder))
  return instanceId
}

// Another window kept the folder and this one missed the event.
const isNoLongerTemporary = (error: unknown) => error instanceof Error && error.message === "temporary_not_temporary"

function clearTemporaryMark(folder: string) {
  for (const instance of instances().values()) {
    if (instance.folder === folder) updateInstance(instance.id, { temporary: false })
  }
}

/** Keeps the folder and its conversations as an ordinary, recent project. */
export async function keepTemporaryInstance(instanceId: string): Promise<boolean> {
  const instance = instances().get(instanceId)
  if (!instance?.temporary) return false
  try {
    await serverApi.keepTemporaryWorkspace(instanceId)
  } catch (error) {
    if (!isNoLongerTemporary(error)) {
      showFailure("temporaryInstance.keep.failedTitle", error)
      return false
    }
  }
  clearTemporaryMark(instance.folder)
  await addNamedRecentFolder(instance.folder, instance.projectName ?? "")
    .catch((error) => log.error("Failed to add the kept project to recent folders", error))
  return true
}

/** Deletes the temporary folder and its conversations; the server refuses while one runs. */
async function discardTemporaryInstance(instanceId: string): Promise<boolean> {
  try {
    await serverApi.discardTemporaryWorkspace(instanceId)
  } catch (error) {
    showFailure("temporaryInstance.discard.failedTitle", error)
    if (!isNoLongerTemporary(error)) return false
    // Kept elsewhere: nothing was deleted; close it like an ordinary project.
    const instance = instances().get(instanceId)
    if (instance) clearTemporaryMark(instance.folder)
  }
  closeInstanceTab(instanceId)
  return true
}

/**
 * A temporary tab cannot be reopened from the recent projects, so closing or
 * stopping it asks whether to keep it as a project or discard it.
 * Cancelling leaves the tab open.
 */
export async function closeTemporaryInstance(instanceId: string): Promise<void> {
  const choice = await showChoiceDialog(tGlobal("temporaryInstance.close.message"), [
    { value: "discard", label: tGlobal("temporaryInstance.close.discard"), tone: "danger" },
    { value: "keep", label: tGlobal("temporaryInstance.close.keep"), tone: "primary" },
  ], {
    title: tGlobal("temporaryInstance.close.title"),
    variant: "warning",
    cancelLabel: tGlobal("temporaryInstance.close.cancel"),
  })
  if (choice === "keep") {
    if (await keepTemporaryInstance(instanceId)) closeInstanceTab(instanceId)
  } else if (choice === "discard") {
    await discardTemporaryInstance(instanceId)
  }
}
