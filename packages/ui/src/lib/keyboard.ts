import { activeInstanceId } from "../stores/instances"
import { selectAppTabByIndex } from "../stores/app-tabs"
import { activeSessionId, setActiveSession, getSessions, activeParentSessionId } from "../stores/sessions"
import { keyboardRegistry } from "./keyboard-registry"
import { isMac } from "./keyboard-utils"

export function setupTabKeyboardShortcuts(
  handleNewInstance: () => void,
  handleCloseActiveTab: () => Promise<void>,
  handleNewSession: (instanceId: string) => void,
  handleCloseSession: (instanceId: string, sessionId: string) => void,
  handleCommandPalette: () => void,
) {
  keyboardRegistry.register({
    id: "session-new",
    key: "n",
    modifiers: {
      shift: true,
      meta: isMac(),
      ctrl: !isMac(),
    },
    handler: () => {
      const instanceId = activeInstanceId()
      if (instanceId) void handleNewSession(instanceId)
    },
    description: "New Session",
    context: "global",
  })

  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "p") {
      e.preventDefault()
      handleCommandPalette()
      return
    }

    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key >= "1" && e.key <= "9") {
      e.preventDefault()
      selectAppTabByIndex(parseInt(e.key) - 1)
    }

    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key >= "1" && e.key <= "9") {
      e.preventDefault()
      const instanceId = activeInstanceId()
      if (!instanceId) return

      const index = parseInt(e.key) - 1
      const parentId = activeParentSessionId().get(instanceId)
      if (!parentId) return

      const sessions = getSessions(instanceId)
      const sessionFamily = sessions.filter((s) => s.id === parentId || s.parentId === parentId)
      const allTabs = sessionFamily.map((s) => s.id).concat(["logs"])

      if (allTabs[index]) {
        setActiveSession(instanceId, allTabs[index])
      }
    }

    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "n") {
      e.preventDefault()
      handleNewInstance()
    }

    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "w") {
      e.preventDefault()
      void handleCloseActiveTab()
    }

    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "w") {
      e.preventDefault()
      const instanceId = activeInstanceId()
      if (!instanceId) return

      const sessionId = activeSessionId().get(instanceId)
      if (sessionId && sessionId !== "logs") {
        handleCloseSession(instanceId, sessionId)
      }
    }
  })
}
