import { tGlobal } from "../lib/i18n"
import { getLogger } from "../lib/logger"
import { showAlertDialog } from "./alerts"
import { activeBlankTabId, replaceBlankTab, getSidecarAppTabId, selectSidecarTab } from "./app-tabs"
import { recordSideCarRecent } from "./preferences"
import { openSidecarTab } from "./sidecars"
import { setShowFolderSelection } from "./ui"

const log = getLogger("actions")

/** Opens a SideCar in a new tab from Browse or the recent tabs, which it then joins. */
export async function openSidecar(sidecarId: string): Promise<void> {
  const blankId = activeBlankTabId()
  try {
    const tab = await openSidecarTab(sidecarId)
    selectSidecarTab(tab.token)
    replaceBlankTab(blankId, getSidecarAppTabId(tab.token))
    setShowFolderSelection(false)
    recordSideCarRecent(sidecarId)
  } catch (error) {
    showAlertDialog(error instanceof Error ? error.message : String(error), {
      variant: "error",
      title: tGlobal("sidecars.open.errorTitle"),
    })
    log.error("Failed to open SideCar", error)
  }
}
