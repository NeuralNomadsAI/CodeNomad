import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import { useI18n } from "../i18n"
import { setWorkspaceMenuEnabled } from "../workspace-open"
import { useConfig } from "../../stores/preferences"
import { getLogger } from "../logger"

export interface ViewMenuItemState {
  label: string
  checked: boolean
  enabled: boolean
}

export interface ViewMenuState {
  leftPanel: ViewMenuItemState
  rightPanel: ViewMenuItemState
  timeline: ViewMenuItemState
  timelineTools: ViewMenuItemState
}

interface ViewMenuPanels {
  enabled: Accessor<boolean>
  leftOpen: Accessor<boolean>
  rightOpen: Accessor<boolean>
  toggleLeft: () => void
  toggleRight: () => void
}

const [panels, setPanels] = createSignal(new Map<string, ViewMenuPanels>())
const log = getLogger("actions")

// The shell owns drawer state; the native menu only observes and operates it.
export function registerViewMenuPanels(instanceId: string, controller: ViewMenuPanels): void {
  setPanels(current => new Map(current).set(instanceId, controller))
  onCleanup(() => setPanels(current => {
    if (current.get(instanceId) !== controller) return current
    const next = new Map(current)
    next.delete(instanceId)
    return next
  }))
}

export function useViewMenu(activeInstanceId: Accessor<string | undefined>) {
  const { t } = useI18n()
  const { preferences, toggleShowMessageTimeline, toggleShowTimelineTools } = useConfig()
  const controller = () => panels().get(activeInstanceId() ?? "")
  const panelEnabled = () => Boolean(controller()?.enabled())
  let pending = Promise.resolve()

  createEffect(() => {
    const enabled = Boolean(activeInstanceId())
    const drawersEnabled = panelEnabled()
    const timeline = preferences().showMessageTimeline
    const state: ViewMenuState = {
      leftPanel: { label: t("window.menu.leftPanel"), checked: drawersEnabled && Boolean(controller()?.leftOpen()), enabled: drawersEnabled },
      rightPanel: { label: t("window.menu.rightPanel"), checked: drawersEnabled && Boolean(controller()?.rightOpen()), enabled: drawersEnabled },
      timeline: { label: t("window.menu.timeline"), checked: timeline, enabled },
      timelineTools: { label: t("window.menu.timelineTools"), checked: preferences().showTimelineTools, enabled: enabled && timeline },
    }
    // Keep IPC updates ordered when a project switch and its shell mount race.
    pending = pending.then(() => setWorkspaceMenuEnabled(enabled, state))
      .catch(error => log.warn("Failed to update native view menu state", error))
  })

  return (action: string): boolean => {
    switch (action) {
      case "view-left-panel":
        if (panelEnabled()) controller()?.toggleLeft()
        return true
      case "view-right-panel":
        if (panelEnabled()) controller()?.toggleRight()
        return true
      case "view-timeline":
        if (activeInstanceId()) toggleShowMessageTimeline()
        return true
      case "view-timeline-tools":
        if (activeInstanceId() && preferences().showMessageTimeline) toggleShowTimelineTools()
        return true
      default:
        return false
    }
  }
}
