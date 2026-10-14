import { onMount, onCleanup, type Accessor } from "solid-js"
import { setupTabKeyboardShortcuts } from "../keyboard"
import { registerNavigationShortcuts } from "../shortcuts/navigation"
import { registerInputShortcuts } from "../shortcuts/input"
import { registerAgentShortcuts } from "../shortcuts/agent"
import { registerEscapeShortcut, setEscapeStateChangeHandler } from "../shortcuts/escape"
import { keyboardRegistry } from "../keyboard-registry"
import { abortSession, getSessions, isSessionBusy } from "../../stores/sessions"
import { showCommandPalette, hideCommandPalette } from "../../stores/command-palette"
import type { Instance } from "../../types/instance"
import { getLogger } from "../logger"
import { emitSessionSidebarRequest } from "../session-sidebar-events"

const log = getLogger("actions")

interface UseAppLifecycleOptions {
  setEscapeInDebounce: (value: boolean) => void
  handleNewInstanceRequest: () => void
  handleCloseActiveTab: () => Promise<void>
  handleNewSession: (instanceId: string) => Promise<void>
  handleCloseSession: (instanceId: string, sessionId: string) => Promise<void>
  showFolderSelection: Accessor<boolean>
  setShowFolderSelection: (value: boolean) => void
  getActiveInstance: () => Instance | null
  getActiveSessionIdForInstance: () => string | null
}

export function useAppLifecycle(options: UseAppLifecycleOptions) {
  onMount(() => {
    setEscapeStateChangeHandler(options.setEscapeInDebounce)
    const isMainView = () => !options.showFolderSelection()
    const hasActiveSession = () => {
      const id = options.getActiveSessionIdForInstance()
      return isMainView() && Boolean(options.getActiveInstance() && id && id !== "info" && id !== "logs")
    }

    const cleanupTabs = setupTabKeyboardShortcuts(
      options.handleNewInstanceRequest,
      options.handleCloseActiveTab,
      options.handleNewSession,
      options.handleCloseSession,
      () => {
        const instance = options.getActiveInstance()
        if (instance) {
          showCommandPalette(instance.id)
        }
      },
      isMainView,
    )

    const cleanupNavigation = registerNavigationShortcuts(isMainView)
    const cleanupInput = registerInputShortcuts(
      () => {
        const textarea = document.querySelector(
          ".session-cache-pane[aria-hidden=\"false\"] .prompt-input",
        ) as HTMLTextAreaElement
        if (textarea) textarea.value = ""
      },
      () => {
        const textarea = document.querySelector(
          ".session-cache-pane[aria-hidden=\"false\"] .prompt-input",
        ) as HTMLTextAreaElement
        textarea?.focus()
      },
      () => hasActiveSession() && Boolean(document.querySelector('.session-cache-pane[aria-hidden="false"] .prompt-input')),
    )

    const cleanupAgent = registerAgentShortcuts(
      () => {
        const instance = options.getActiveInstance()
        if (!instance) return
        emitSessionSidebarRequest({ instanceId: instance.id, action: "focus-model-selector" })
      },
      () => {
        const instance = options.getActiveInstance()
        if (!instance) return
        emitSessionSidebarRequest({ instanceId: instance.id, action: "focus-agent-selector" })
      },
      () => {
        const instance = options.getActiveInstance()
        if (!instance) return
        emitSessionSidebarRequest({ instanceId: instance.id, action: "focus-variant-selector" })
      },
      hasActiveSession,
    )

    const cleanupEscape = registerEscapeShortcut(
      () => {
        const instance = options.getActiveInstance()
        if (!instance) return false

        const sessionId = options.getActiveSessionIdForInstance()
        if (!sessionId || sessionId === "info") return false

        const sessions = getSessions(instance.id)
        const session = sessions.find((s) => s.id === sessionId)
        if (!session) return false

        return isSessionBusy(instance.id, sessionId)
      },
      async () => {
        const instance = options.getActiveInstance()
        const sessionId = options.getActiveSessionIdForInstance()
        if (!instance || !sessionId || sessionId === "info") return

        try {
          await abortSession(instance.id, sessionId)
          log.info("Session aborted successfully", { instanceId: instance.id, sessionId })
        } catch (error) {
          log.error("Failed to abort session", error)
        }
      },
      () => {
        const active = document.activeElement as HTMLElement
        active?.blur()
      },
      () => hideCommandPalette(),
      hasActiveSession,
      { isOpen: options.showFolderSelection, close: () => options.setShowFolderSelection(false) },
    )

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector('[role="dialog"][aria-modal="true"]')) return
      const target = e.target instanceof Element ? e.target : null

      const isInCombobox = Boolean(target?.closest('[role="combobox"]'))
      const isInListbox = Boolean(target?.closest('[role="listbox"]'))
      const isInAgentSelect = Boolean(target?.closest('[role="button"][data-agent-selector]'))

      if (isInCombobox || isInListbox || isInAgentSelect) {
        return
      }

      const shortcut = keyboardRegistry.findMatch(e)
      if (shortcut) {
        e.preventDefault()
        if (!(shortcut.id === "session-abort" && e.repeat)) shortcut.handler()
      }
    }

    window.addEventListener("keydown", handleKeyDown)

    onCleanup(() => {
      window.removeEventListener("keydown", handleKeyDown)
      cleanupTabs()
      cleanupNavigation()
      cleanupInput()
      cleanupAgent()
      cleanupEscape()
    })
  })
}
