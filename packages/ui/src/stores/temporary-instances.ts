import { serverApi } from "../lib/api-client"
import { tGlobal } from "../lib/i18n"
import { getLogger } from "../lib/logger"
import { showAlertDialog, showChoiceDialog } from "./alerts"
import { closeInstanceTab } from "./app-tabs"
import { createInstance, instances, updateInstance } from "./instances"
import { addNamedRecentFolder } from "./preferences"

const log = getLogger("api")

function showFailure(titleKey: string, error: unknown) {
  showAlertDialog(error instanceof Error ? error.message : String(error), {
    title: tGlobal(titleKey),
    variant: "error",
  })
}

/** Opens a new tab on an empty CodeNomad-managed folder, outside the recent projects. */
export async function openTemporaryInstance(): Promise<string> {
  const { path } = await serverApi.createTemporaryFolder()
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  const { instanceId } = await createInstance(path, tGlobal("temporaryInstance.name", { time }))
  return instanceId
}

/** Keeps the folder and its conversations as an ordinary, recent project. */
export async function keepTemporaryInstance(instanceId: string): Promise<boolean> {
  const instance = instances().get(instanceId)
  if (!instance?.temporary) return false
  try {
    await serverApi.keepTemporaryWorkspace(instanceId)
  } catch (error) {
    showFailure("temporaryInstance.keep.failedTitle", error)
    return false
  }
  for (const other of instances().values()) {
    if (other.folder === instance.folder) updateInstance(other.id, { temporary: false })
  }
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
    return false
  }
  closeInstanceTab(instanceId)
  return true
}

/**
 * A temporary tab cannot be reopened once closed, so closing asks whether to
 * keep it as a project or discard it. Cancelling leaves the tab open.
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
