import { createSignal, onMount } from "solid-js"
import type { Accessor } from "solid-js"
import type { Preferences, ExpansionPreference } from "../../stores/preferences"
import { createCommandRegistry, type Command } from "../commands"
import { instances, activeInstanceId, setActiveInstanceId } from "../../stores/instances"
import type { ClientPart, MessageInfo } from "../../types/message"
import {
  activeParentSessionId,
  activeSessionId as activeSessionMap,
  getSessionFamily,
  getSessions,
  setActiveSession,
} from "../../stores/sessions"
import { setSessionCompactionState } from "../../stores/session-compaction"
import { showAlertDialog } from "../../stores/alerts"
import type { Instance } from "../../types/instance"
import type { MessageRecord } from "../../stores/message-v2/types"
import { messageStoreBus } from "../../stores/message-v2/bus"
import { cleanupBlankSessions } from "../../stores/session-state"

export interface UseCommandsOptions {
  preferences: Accessor<Preferences>
  toggleShowThinkingBlocks: () => void
  toggleUsageMetrics: () => void
  setDiffViewMode: (mode: "split" | "unified") => void
  setToolOutputExpansion: (mode: ExpansionPreference) => void
  setDiagnosticsExpansion: (mode: ExpansionPreference) => void
  setThinkingBlocksExpansion: (mode: ExpansionPreference) => void
  handleNewInstanceRequest: () => void
  handleCloseInstance: (instanceId: string) => Promise<void>
  handleNewSession: (instanceId: string) => Promise<void>
  handleCloseSession: (instanceId: string, sessionId: string) => Promise<void>
  getActiveInstance: () => Instance | null
  getActiveSessionIdForInstance: () => string | null
}

function extractUserTextFromRecord(record?: MessageRecord): string | null {
  if (!record) return null
  const parts = record.partIds
    .map((partId) => record.parts[partId]?.data)
    .filter((part): part is ClientPart => Boolean(part))
  const textParts = parts.filter((part): part is ClientPart & { type: "text"; text: string } => part.type === "text" && typeof (part as any).text === "string")
  if (textParts.length === 0) {
    return null
  }
  return textParts.map((part) => (part as any).text as string).join("\n")
}

export function useCommands(options: UseCommandsOptions) {
  const commandRegistry = createCommandRegistry()
  const [commands, setCommands] = createSignal<Command[]>([])

  function refreshCommands() {
    setCommands(commandRegistry.getAll())
  }

  function registerCommands() {
    const activeInstance = options.getActiveInstance
    const activeSessionIdForInstance = options.getActiveSessionIdForInstance

    commandRegistry.register({
      id: "new-instance",
      label: "New Instance",
      description: "Open folder picker to create new instance",
      category: "Instance",
      keywords: ["folder", "project", "workspace"],
      shortcut: { key: "N", meta: true },
      action: options.handleNewInstanceRequest,
    })

    commandRegistry.register({
      id: "close-instance",
      label: "Close Instance",
      description: "Stop current instance's server",
      category: "Instance",
      keywords: ["stop", "quit", "close"],
      shortcut: { key: "W", meta: true },
      action: async () => {
        const instance = activeInstance()
        if (!instance) return
        await options.handleCloseInstance(instance.id)
      },
    })

    commandRegistry.register({
      id: "instance-next",
      label: "Next Instance",
      description: "Cycle to next instance tab",
      category: "Instance",
      keywords: ["switch", "navigate"],
      shortcut: { key: "]", meta: true },
      action: () => {
        const ids = Array.from(instances().keys())
        if (ids.length <= 1) return
        const current = ids.indexOf(activeInstanceId() || "")
        const next = (current + 1) % ids.length
        if (ids[next]) setActiveInstanceId(ids[next])
      },
    })

    commandRegistry.register({
      id: "instance-prev",
      label: "Previous Instance",
      description: "Cycle to previous instance tab",
      category: "Instance",
      keywords: ["switch", "navigate"],
      shortcut: { key: "[", meta: true },
      action: () => {
        const ids = Array.from(instances().keys())
        if (ids.length <= 1) return
        const current = ids.indexOf(activeInstanceId() || "")
        const prev = current <= 0 ? ids.length - 1 : current - 1
        if (ids[prev]) setActiveInstanceId(ids[prev])
      },
    })

    commandRegistry.register({
      id: "new-session",
      label: "New Session",
      description: "Create a new parent session",
      category: "Session",
      keywords: ["create", "start"],
      shortcut: { key: "N", meta: true, shift: true },
      action: async () => {
        const instance = activeInstance()
        if (!instance) return
        await options.handleNewSession(instance.id)
      },
    })

    commandRegistry.register({
      id: "close-session",
      label: "Close Session",
      description: "Close current parent session",
      category: "Session",
      keywords: ["close", "stop"],
      shortcut: { key: "W", meta: true, shift: true },
      action: async () => {
        const instance = activeInstance()
        const sessionId = activeSessionIdForInstance()
        if (!instance || !sessionId || sessionId === "info") return
        await options.handleCloseSession(instance.id, sessionId)
      },
    })

    commandRegistry.register({
      id: "cleanup-blank-sessions",
      label: "Cleanup Blank Sessions",
      description: "Remove empty sessions from the current instance",
      category: "Session",
      keywords: ["cleanup", "blank", "empty", "sessions", "remove", "delete"],
      action: async () => {
        const instance = activeInstance()
        if (!instance) return
        await cleanupBlankSessions(instance.id, undefined, true)
      },
    })

    commandRegistry.register({
      id: "switch-to-info",
      label: "Instance Info",
      description: "Open the instance overview for logs and status",
      category: "Instance",
      keywords: ["info", "logs", "console", "output"],
      shortcut: { key: "L", meta: true, shift: true },
      action: () => {
        const instance = activeInstance()
        if (instance) setActiveSession(instance.id, "info")
      },
    })

    commandRegistry.register({
      id: "session-next",
      label: "Next Session",
      description: "Cycle to next session tab",
      category: "Session",
      keywords: ["switch", "navigate"],
      shortcut: { key: "]", meta: true, shift: true },
      action: () => {
        const instanceId = activeInstanceId()
        if (!instanceId) return
        const parentId = activeParentSessionId().get(instanceId)
        if (!parentId) return
        const familySessions = getSessionFamily(instanceId, parentId)
        const ids = familySessions.map((s) => s.id).concat(["info"])
        if (ids.length <= 1) return
        const current = ids.indexOf(activeSessionMap().get(instanceId) || "")
        const next = (current + 1) % ids.length
        if (ids[next]) setActiveSession(instanceId, ids[next])
      },
    })

    commandRegistry.register({
      id: "session-prev",
      label: "Previous Session",
      description: "Cycle to previous session tab",
      category: "Session",
      keywords: ["switch", "navigate"],
      shortcut: { key: "[", meta: true, shift: true },
      action: () => {
        const instanceId = activeInstanceId()
        if (!instanceId) return
        const parentId = activeParentSessionId().get(instanceId)
        if (!parentId) return
        const familySessions = getSessionFamily(instanceId, parentId)
        const ids = familySessions.map((s) => s.id).concat(["info"])
        if (ids.length <= 1) return
        const current = ids.indexOf(activeSessionMap().get(instanceId) || "")
        const prev = current <= 0 ? ids.length - 1 : current - 1
        if (ids[prev]) setActiveSession(instanceId, ids[prev])
      },
    })

    commandRegistry.register({
      id: "compact",
      label: "Compact Session",
      description: "Summarize and compact the current session",
      category: "Session",
      keywords: ["/compact", "summarize", "compress"],
      action: async () => {
        const instance = activeInstance()
        const sessionId = activeSessionIdForInstance()
        if (!instance || !instance.client || !sessionId || sessionId === "info") return

        const sessions = getSessions(instance.id)
        const session = sessions.find((s) => s.id === sessionId)
        if (!session) return

        try {
          setSessionCompactionState(instance.id, sessionId, true)
          await instance.client.session.summarize({
            path: { id: sessionId },
            body: {
              providerID: session.model.providerId,
              modelID: session.model.modelId,
            },
          })
        } catch (error: unknown) {
          setSessionCompactionState(instance.id, sessionId, false)
          console.error("Failed to compact session:", error)
          const message = error instanceof Error ? error.message : "Failed to compact session"
          showAlertDialog(`Compact failed: ${message}`, {
            title: "Compact failed",
            variant: "error",
          })
        }
      },
    })

    commandRegistry.register({
      id: "undo",
      label: "Undo Last Message",
      description: "Revert the last message",
      category: "Session",
      keywords: ["/undo", "revert", "undo"],
      action: async () => {
        const instance = activeInstance()
        const sessionId = activeSessionIdForInstance()
        if (!instance || !instance.client || !sessionId || sessionId === "info") return

        const sessions = getSessions(instance.id)
        const session = sessions.find((s) => s.id === sessionId)
        if (!session) return

        const store = messageStoreBus.getOrCreate(instance.id)
        const messageIds = store.getSessionMessageIds(sessionId)
        const infoMap = new Map<string, MessageInfo>()
        messageIds.forEach((id) => {
          const info = store.getMessageInfo(id)
          if (info) infoMap.set(id, info)
        })

        const revertState = store.getSessionRevert(sessionId) ?? session.revert
        let after = 0
        if (revertState?.messageID) {
          const revertInfo = infoMap.get(revertState.messageID) ?? store.getMessageInfo(revertState.messageID)
          after = revertInfo?.time?.created || 0
        }

        let messageID = ""
        let restoredText: string | null = null
        for (let i = messageIds.length - 1; i >= 0; i--) {
          const id = messageIds[i]
          const record = store.getMessage(id)
          const info = infoMap.get(id) ?? store.getMessageInfo(id)
          if (record?.role === "user" && info?.time?.created) {
            if (after > 0 && info.time.created >= after) {
              continue
            }
            messageID = id
            restoredText = extractUserTextFromRecord(record)
            break
          }
        }

        if (!messageID) {
          showAlertDialog("Nothing to undo", {
            title: "No actions to undo",
            variant: "info",
          })
          return
        }

        try {
          await instance.client.session.revert({
            path: { id: sessionId },
            body: { messageID },
          })

          if (!restoredText) {
            const fallbackRecord = store.getMessage(messageID)
            restoredText = extractUserTextFromRecord(fallbackRecord)
          }

          if (restoredText) {
            const textarea = document.querySelector(".prompt-input") as HTMLTextAreaElement
            if (textarea) {
              textarea.value = restoredText
              textarea.dispatchEvent(new Event("input", { bubbles: true }))
              textarea.focus()
            }
          }
        } catch (error) {
          console.error("Failed to revert message:", error)
          showAlertDialog("Failed to revert message", {
            title: "Undo failed",
            variant: "error",
          })
        }
      },
    })

    commandRegistry.register({
      id: "open-model-selector",
      label: "Open Model Selector",
      description: "Choose a different model",
      category: "Agent & Model",
      keywords: ["model", "llm", "ai"],
      shortcut: { key: "M", meta: true, shift: true },
      action: () => {
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
    })

    commandRegistry.register({
      id: "open-agent-selector",
      label: "Open Agent Selector",
      description: "Choose a different agent",
      category: "Agent & Model",
      keywords: ["agent", "mode"],
      shortcut: { key: "A", meta: true, shift: true },
      action: () => {
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
    })

    commandRegistry.register({
      id: "clear-input",
      label: "Clear Input",
      description: "Clear the prompt textarea",
      category: "Input & Focus",
      keywords: ["clear", "reset"],
      shortcut: { key: "K", meta: true },
      action: () => {
        const textarea = document.querySelector(".prompt-input") as HTMLTextAreaElement
        if (textarea) textarea.value = ""
      },
    })

    commandRegistry.register({
      id: "thinking",
      label: () => `${options.preferences().showThinkingBlocks ? "Hide" : "Show"} Thinking Blocks`,
      description: "Show/hide AI thinking process",
      category: "System",
      keywords: ["/thinking", "thinking", "reasoning", "toggle", "show", "hide"],
      action: options.toggleShowThinkingBlocks,
    })

    commandRegistry.register({
      id: "thinking-default-visibility",
      label: () => {
        const mode = options.preferences().thinkingBlocksExpansion ?? "expanded"
        return `Thinking Blocks Default · ${mode === "expanded" ? "Expanded" : "Collapsed"}`
      },
      description: "Toggle whether thinking blocks start expanded",
      category: "System",
      keywords: ["/thinking", "thinking", "reasoning", "expand", "collapse", "default"],
      action: () => {
        const mode = options.preferences().thinkingBlocksExpansion ?? "expanded"
        const next: ExpansionPreference = mode === "expanded" ? "collapsed" : "expanded"
        options.setThinkingBlocksExpansion(next)
      },
    })

    commandRegistry.register({
      id: "diff-view-split",
      label: () => `${(options.preferences().diffViewMode || "split") === "split" ? "✓ " : ""}Use Split Diff View`,
      description: "Display tool-call diffs side-by-side",
      category: "System",
      keywords: ["diff", "split", "view"],
      action: () => options.setDiffViewMode("split"),
    })

    commandRegistry.register({
      id: "diff-view-unified",
      label: () => `${(options.preferences().diffViewMode || "split") === "unified" ? "✓ " : ""}Use Unified Diff View`,
      description: "Display tool-call diffs inline",
      category: "System",
      keywords: ["diff", "unified", "view"],
      action: () => options.setDiffViewMode("unified"),
    })

    commandRegistry.register({
      id: "tool-output-default-visibility",
      label: () => {
        const mode = options.preferences().toolOutputExpansion || "expanded"
        return `Tool Outputs Default · ${mode === "expanded" ? "Expanded" : "Collapsed"}`
      },
      description: "Toggle default expansion for tool outputs",
      category: "System",
      keywords: ["tool", "output", "expand", "collapse"],
      action: () => {
        const mode = options.preferences().toolOutputExpansion || "expanded"
        const next: ExpansionPreference = mode === "expanded" ? "collapsed" : "expanded"
        options.setToolOutputExpansion(next)
      },
    })

    commandRegistry.register({
      id: "diagnostics-default-visibility",
      label: () => {
        const mode = options.preferences().diagnosticsExpansion || "expanded"
        return `Diagnostics Default · ${mode === "expanded" ? "Expanded" : "Collapsed"}`
      },
      description: "Toggle default expansion for diagnostics output",
      category: "System",
      keywords: ["diagnostics", "expand", "collapse"],
      action: () => {
        const mode = options.preferences().diagnosticsExpansion || "expanded"
        const next: ExpansionPreference = mode === "expanded" ? "collapsed" : "expanded"
        options.setDiagnosticsExpansion(next)
      },
    })

    commandRegistry.register({
      id: "token-usage-visibility",
      label: () => {
        const visible = options.preferences().showUsageMetrics ?? true
        return `Token Usage Display · ${visible ? "Visible" : "Hidden"}`
      },
      description: "Show or hide token and cost stats for assistant messages",
      category: "System",
      keywords: ["token", "usage", "cost", "stats"],
      action: options.toggleUsageMetrics,
    })
 
    commandRegistry.register({
      id: "help",
      label: "Show Help",

      description: "Display keyboard shortcuts and help",
      category: "System",
      keywords: ["/help", "shortcuts", "help"],
      action: () => {
        console.log("Show help modal (not implemented)")
      },
    })
  }

  function executeCommand(command: Command) {
    try {
      const result = command.action?.()
      if (result instanceof Promise) {
        void result.catch((error) => {
          console.error("Command execution failed:", error)
        })
      }
    } catch (error) {
      console.error("Command execution failed:", error)
    }
  }

  onMount(() => {
    registerCommands()
    refreshCommands()
  })

  return {
    commands,
    commandRegistry,
    refreshCommands,
    executeCommand,
  }
}
