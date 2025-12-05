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

const log = getLogger("actions")

interface UseAppLifecycleOptions {
  setEscapeInDebounce: (value: boolean) => void
  handleNewInstanceRequest: () => void
  handleCloseInstance: (instanceId: string) => Promise<void>
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

    setupTabKeyboardShortcuts(
      options.handleNewInstanceRequest,
      options.handleCloseInstance,
      options.handleNewSession,
      options.handleCloseSession,
      () => {
        const instance = options.getActiveInstance()
        if (instance) {
          showCommandPalette(instance.id)
        }
      },
    )

    registerNavigationShortcuts()
    registerInputShortcuts(
      () => {
        const textarea = document.querySelector(".prompt-input") as HTMLTextAreaElement
        if (textarea) textarea.value = ""
      },
      () => {
        const textarea = document.querySelector(".prompt-input") as HTMLTextAreaElement
        textarea?.focus()
      },
    )

    registerAgentShortcuts(
      () => {
        const modelInput = document.querySelector("[data-model-selector]") as HTMLInputElement
        if (modelInput) {
          modelInput.focus()
          setTimeout(() => {
            const event = new KeyboardEvent("keydown", {
              key: "ArrowDown",
              code: "ArrowDown",
              keyCode: 40,
              which: 40,
              bubbles: true,
              cancelable: true,
            })
            modelInput.dispatchEvent(event)
          }, 10)
        }
      },
      () => {
        const agentTrigger = document.querySelector("[data-agent-selector]") as HTMLElement
        if (agentTrigger) {
          agentTrigger.focus()
          setTimeout(() => {
            const event = new KeyboardEvent("keydown", {
              key: "Enter",
              code: "Enter",
              keyCode: 13,
              which: 13,
              bubbles: true,
              cancelable: true,
            })
            agentTrigger.dispatchEvent(event)
          }, 50)
        }
      },
    )

    registerEscapeShortcut(
      () => {
        if (options.showFolderSelection()) return true

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
        if (options.showFolderSelection()) {
          options.setShowFolderSelection(false)
          return
        }

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
    )

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement

      const isInCombobox = target.closest('[role="combobox"]') !== null
      const isInListbox = target.closest('[role="listbox"]') !== null
      const isInAgentSelect = target.closest('[role="button"][data-agent-selector]') !== null

      if (isInCombobox || isInListbox || isInAgentSelect) {
        return
      }

      const shortcut = keyboardRegistry.findMatch(e)
      if (shortcut) {
        e.preventDefault()
        shortcut.handler()
      }
    }

    window.addEventListener("keydown", handleKeyDown)

    onCleanup(() => {
      window.removeEventListener("keydown", handleKeyDown)
    })
  })
}
