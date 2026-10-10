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

// A kept folder leaves the registry; every window drops its temporary mark.
serverEvents.on("workspace.temporaryChanged", (event) => {
  if (event.type !== "workspace.temporaryChanged") return
  const registered = new Set(event.folders)
  for (const instance of instances().values()) {
    if (instance.temporary && !registered.has(instance.folder)) updateInstance(instance.id, { temporary: false })
  }
})

function temporaryName(date: Date): string {
  const time = date.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
  return tGlobal("temporaryInstance.name", { time })
}

/**
 * Opens a new tab on an empty CodeNomad-managed folder, outside the recent
 * projects. Like any project tab it is saved with the app state and restored
 * on restart, still marked temporary.
 */
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
