import { activeInstanceId } from "../stores/instances"
import { selectAppTabByIndex } from "../stores/app-tabs"
import { activeSessionId, setActiveSession, getSessionFamily, activeParentSessionId } from "../stores/sessions"
import { keyboardRegistry } from "./keyboard-registry"

export function setupTabKeyboardShortcuts(
  handleNewInstance: () => void,
  handleCloseActiveTab: () => Promise<void>,
  handleNewSession: (instanceId: string) => void,
  handleCloseSession: (instanceId: string, sessionId: string) => void,
  handleCommandPalette: () => void,
  isMainView: () => boolean = () => true,
) {
  const registered: string[] = []
  function register(id: string, handler: () => void, condition = () => true) {
    keyboardRegistry.register({ id, handler, description: id, context: "global", condition })
    registered.push(id)
  }
  const hasInstance = () => isMainView() && Boolean(activeInstanceId())
  const hasSession = () => {
    const instanceId = activeInstanceId()
    const sessionId = instanceId && activeSessionId().get(instanceId)
    return hasInstance() && Boolean(sessionId && sessionId !== "logs" && sessionId !== "info")
  }
  register("session-new", () => { const id = activeInstanceId(); if (id) handleNewSession(id) }, hasInstance)
  register("open-command-palette", handleCommandPalette, hasInstance)
  register("new-instance", handleNewInstance, isMainView)
  register("close-instance", () => { void handleCloseActiveTab() })
  register("close-session", () => {
    const instanceId = activeInstanceId()
    const sessionId = instanceId && activeSessionId().get(instanceId)
    if (instanceId && sessionId) handleCloseSession(instanceId, sessionId)
  }, hasSession)
  for (let index = 0; index < 9; index++) {
    register(`app-tab-${index + 1}`, () => selectAppTabByIndex(index))
    register(`session-tab-${index + 1}`, () => {
      const instanceId = activeInstanceId()
      if (!instanceId) return
      const parentId = activeParentSessionId().get(instanceId)
      if (!parentId) return
      const tabs = getSessionFamily(instanceId, parentId).map(session => session.id).concat(["logs"])
      if (tabs[index]) setActiveSession(instanceId, tabs[index])
    }, hasInstance)
  }
  // All actions use the shared dispatcher; no anonymous global listener survives cleanup.
  return () => registered.forEach(id => keyboardRegistry.unregister(id))
}
