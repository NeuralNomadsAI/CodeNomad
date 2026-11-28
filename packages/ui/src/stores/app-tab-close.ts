import {
  activeAppTabId, appTabs, closeBlankTab, closeInstanceTab, detachInstanceTab,
  getAdjacentAppTabId, getAppTabById, markAppTabUserInteraction, selectAppTab,
} from "./app-tabs"
import { closeSidecarTab } from "./sidecars"
import { closeTemporaryInstance } from "./temporary-instances"

export async function closeAppTab(
  tabId: string, { retainWorkspace = false, current = () => true }: { retainWorkspace?: boolean; current?: () => boolean } = {},
): Promise<void> {
  const tab = getAppTabById(tabId)
  if (!tab) return
  markAppTabUserInteraction()

  const wasActive = activeAppTabId() === tabId
  const fallback = wasActive ? getAdjacentAppTabId(tabId) : activeAppTabId()
  if (tab.kind === "instance") {
    if (tab.instance.temporary) {
      await closeTemporaryInstance(tab.instance.id, { retainWorkspace, current })
      return
    }
    if (retainWorkspace) detachInstanceTab(tab.instance.id)
    else closeInstanceTab(tab.instance.id)
  } else if (tab.kind === "remote-restore") {
    tab.remove({ retainWorkspace })
  } else if (tab.kind === "blank") {
    closeBlankTab(tab.id)
  } else {
    closeSidecarTab(tab.sidecarTab.token)
  }
  if (wasActive && !getAppTabById(activeAppTabId())) {
    selectAppTab(getAppTabById(fallback)?.id ?? appTabs()[0]?.id ?? null)
  }
}
