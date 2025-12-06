import { instances, activeInstanceId, setActiveInstanceId } from "../stores/instances"
import { activeSessionId, setActiveSession, getSessions, activeParentSessionId } from "../stores/sessions"
import { keyboardRegistry } from "./keyboard-registry"
import { isMac } from "./keyboard-utils"

export function setupTabKeyboardShortcuts(
  handleNewInstance: () => void,
  handleCloseInstance: (instanceId: string) => void,
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
    // Allow clipboard shortcuts to work normally
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && ['c', 'v', 'a', 'x', 'z', 'y'].includes(e.key.toLowerCase())) {
      return
    }

    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "p") {
      e.preventDefault()
      handleCommandPalette()
      return
    }

    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key >= "1" && e.key <= "9") {
      e.preventDefault()
      const index = parseInt(e.key) - 1
      const instanceIds = Array.from(instances().keys())
      if (instanceIds[index]) {
        setActiveInstanceId(instanceIds[index])
      }
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
      const instanceId = activeInstanceId()
      if (instanceId) {
        handleCloseInstance(instanceId)
      }
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
