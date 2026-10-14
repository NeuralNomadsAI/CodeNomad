import { serverApi } from "../lib/api-client"
import { tGlobal } from "../lib/i18n"
import { getLogger } from "../lib/logger"
import { serverEvents } from "../lib/server-events"
import { showAlertDialog, showChoiceDialog } from "./alerts"
import { activeAppTabId, closeInstanceTab, getAdjacentAppTabId, getInstanceAppTabId, selectAppTab, selectInstanceTab } from "./app-tabs"
import { getSessionAttachmentsForInstance } from "./attachments"
import { createInstance, instances, updateInstance } from "./instances"
import { addNamedRecentFolder } from "./preferences"
import { getSessionDraftPromptsForInstance, getSessions } from "./sessions"

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

/** Tabs opened within the same minute get "(2)", "(3)"… so they stay distinguishable. */
function temporaryName(date: Date): string {
  const time = date.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
  const base = tGlobal("temporaryInstance.name", { time })
  const taken = new Set([...instances().values()].map((instance) => instance.projectName))
  let name = base
  for (let index = 2; taken.has(name); index += 1) name = `${base} (${index})`
  return name
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

/**
 * Deletes the temporary folder and its conversations. A visible tab first
 * yields to its neighbour (or closes, if it is the last tab), so it is hidden
 * like an inactive tab when the server stops the workspace; the stop handler
 * itself clears the instance only after its tab has unmounted. A refusal
 * deletes nothing and restores the tab in place. `quiet` is the unprompted
 * empty-tab path: it shows no errors and only succeeds when the server finds
 * no conversation or file.
 */
async function discardTemporaryInstance(instanceId: string, quiet = false): Promise<boolean> {
  const tabId = getInstanceAppTabId(instanceId)
  const wasActive = activeAppTabId() === tabId
  const neighbour = wasActive ? getAdjacentAppTabId(tabId) : null
  if (wasActive && neighbour) selectAppTab(neighbour)
  else if (wasActive) closeInstanceTab(instanceId)
  try {
    await serverApi.discardTemporaryWorkspace(instanceId, quiet ? { onlyIfEmpty: true } : {})
  } catch (error) {
    if (!isNoLongerTemporary(error)) {
      if (instances().has(instanceId)) {
        if (neighbour) selectAppTab(tabId)
        else if (wasActive) selectInstanceTab(instanceId)
      }
      if (!quiet) showFailure("temporaryInstance.discard.failedTitle", error)
      return false
    }
    // Kept elsewhere: nothing was deleted; it closes like an ordinary project.
    if (!quiet) showFailure("temporaryInstance.discard.failedTitle", error)
    const instance = instances().get(instanceId)
    if (instance) clearTemporaryMark(instance.folder)
  }
  closeInstanceTab(instanceId)
  return true
}

/** Unsent composer text or attachments are work an unprompted discard would lose. */
function hasUnsentWork(instanceId: string): boolean {
  return Object.keys(getSessionDraftPromptsForInstance(instanceId)).length > 0
    || Object.values(getSessionAttachmentsForInstance(instanceId)).some((attachments) => attachments.length > 0)
}

/**
 * A temporary tab cannot be reopened from the recent projects. An untouched
 * one (no conversation, file or unsent draft; the server rechecks the first
 * two) closes and is discarded without asking. Otherwise, or if that quiet
 * discard does not succeed, closing or stopping it asks whether to keep it as
 * a project or discard it. Cancelling leaves the tab open.
 */
export async function closeTemporaryInstance(instanceId: string): Promise<void> {
  if (getSessions(instanceId).length === 0 && !hasUnsentWork(instanceId)
    && await discardTemporaryInstance(instanceId, true)) return
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
