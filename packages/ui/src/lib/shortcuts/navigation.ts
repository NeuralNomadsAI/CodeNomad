import { keyboardRegistry } from "../keyboard-registry"
import { activeInstanceId } from "../../stores/instances"
import { selectNextAppTab, selectPreviousAppTab } from "../../stores/app-tabs"
import { activeSessionId, getVisibleSessionIds, setActiveSession, setActiveSessionFromList } from "../../stores/sessions"

export function registerNavigationShortcuts(isMainView: () => boolean = () => true) {
  const hasInstance = () => isMainView() && Boolean(activeInstanceId())
  keyboardRegistry.register({
    id: "instance-prev",
    handler: () => selectPreviousAppTab(),
    description: "previous tab",
    context: "global",
  })

  keyboardRegistry.register({
    id: "instance-next",
    handler: () => selectNextAppTab(),
    description: "next tab",
    context: "global",
  })

  keyboardRegistry.register({
    id: "session-prev",
    condition: hasInstance,
    handler: () => {
      const instanceId = activeInstanceId()
      if (!instanceId) return

      const navigationIds = getVisibleSessionIds(instanceId)
      if (navigationIds.length === 0) return

      const currentActiveId = activeSessionId().get(instanceId) ?? ""
      const currentIndex = navigationIds.indexOf(currentActiveId)

      const targetIndex =
        currentIndex === -1
          ? navigationIds.length - 1
          : currentIndex <= 0
            ? navigationIds.length - 1
            : currentIndex - 1

      const targetSessionId = navigationIds[targetIndex]
      if (targetSessionId) {
        setActiveSessionFromList(instanceId, targetSessionId)
      }
    },
    description: "previous session",
    context: "global",
  })

  keyboardRegistry.register({
    id: "session-next",
    condition: hasInstance,
    handler: () => {
      const instanceId = activeInstanceId()
      if (!instanceId) return

      const navigationIds = getVisibleSessionIds(instanceId)
      if (navigationIds.length === 0) return

      const currentActiveId = activeSessionId().get(instanceId) ?? ""
      const currentIndex = navigationIds.indexOf(currentActiveId)
      const targetIndex = (currentIndex + 1 + navigationIds.length) % navigationIds.length

      const targetSessionId = navigationIds[targetIndex]
      if (targetSessionId) {
        setActiveSessionFromList(instanceId, targetSessionId)
      }
    },
    description: "next session",
    context: "global",
  })

  keyboardRegistry.register({
    id: "switch-to-info",
    condition: hasInstance,
    handler: () => {
      const instanceId = activeInstanceId()
      if (instanceId) setActiveSession(instanceId, "info")
    },
    description: "info tab",
    context: "global",
  })
  return () => ["instance-prev", "instance-next", "session-prev", "session-next", "switch-to-info"].forEach(id => keyboardRegistry.unregister(id))
}
