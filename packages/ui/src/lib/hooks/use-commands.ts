import { createSignal, onMount } from "solid-js"
import type { Accessor } from "solid-js"
import type {
  Preferences,
  ExpansionPreference,
  ToolInputsVisibilityPreference,
  VisibilityPreference,
} from "../../stores/preferences"
import { createCommandRegistry, type Command } from "../commands"
import { activeInstanceId } from "../../stores/instances"
import { selectNextAppTab, selectPreviousAppTab } from "../../stores/app-tabs"
import type { ClientPart, MessageInfo } from "../../types/message"
import { getSessions, getVisibleSessionIds, setActiveSession, setActiveSessionFromList } from "../../stores/sessions"
import { showAlertDialog, showConfirmDialog } from "../../stores/alerts"
import type { Instance } from "../../types/instance"
import type { MessageRecord } from "../../stores/message-v2/types"
import { messageStoreBus } from "../../stores/message-v2/bus"
import { cleanupBlankSessions } from "../../stores/session-state"
import { getLogger } from "../logger"
import { emitSessionSidebarRequest } from "../session-sidebar-events"
import { tGlobal } from "../i18n"
import { registerBehaviorCommands } from "../settings/behavior-registry"
import { canOpenWorkspacePaths, openWorkspacePath, type WorkspaceEditor, type WorkspaceOpenTarget } from "../workspace-open"
import { getDefaultWorktreeSlug, getWorktreeSlugForSession } from "../../stores/worktrees"
import { compactSession, executeSessionTechnicalPartDeletion, planSessionTechnicalPartDeletion } from "../../stores/session-actions"

const log = getLogger("actions")

function splitKeywords(key: string): string[] {
  return tGlobal(key)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
}


export interface UseCommandsOptions {
  preferences: Accessor<Preferences>
  toggleShowThinkingBlocks: () => void
  toggleKeyboardShortcutHints: () => void
  toggleShowMessageTimeline: () => void
  toggleShowTimelineTools: () => void
  toggleUsageMetrics: () => void
  toggleAutoCleanupBlankSessions: () => void
  togglePromptSubmitOnEnter: () => void
  toggleShowPromptVoiceInput: () => void
  setDiffViewMode: (mode: "split" | "unified") => void
  setToolOutputExpansion: (mode: VisibilityPreference) => void
  setDiagnosticsExpansion: (mode: VisibilityPreference) => void
  setThinkingBlocksExpansion: (mode: ExpansionPreference) => void
  setToolInputsVisibility: (mode: ToolInputsVisibilityPreference) => void
  handleNewInstanceRequest: () => void
  handleCloseActiveTab: () => Promise<void>
  handleStopInstance: (instanceId: string) => Promise<void>
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

    const activeWorkspace = () => {
      const instance = activeInstance()
      if (!instance) return null
      const sessionId = activeSessionIdForInstance()
      const worktreeSlug = !sessionId || sessionId === "info"
        ? getDefaultWorktreeSlug(instance.id)
        : getWorktreeSlugForSession(instance.id, sessionId)
      return { instanceId: instance.id, worktreeSlug }
    }

    const openActiveWorkspace = async (target: WorkspaceOpenTarget, editor?: WorkspaceEditor) => {
      const workspace = activeWorkspace()
      if (!workspace) {
        showAlertDialog(tGlobal("commands.openWorkspace.projectRequired.message"), {
          title: tGlobal("commands.openWorkspace.projectRequired.title"),
        })
        return
      }
      try {
        await openWorkspacePath({ target, ...workspace, editor })
      } catch (error) {
        showAlertDialog(tGlobal("commands.openWorkspace.failed.message", {
          message: error instanceof Error ? error.message : String(error),
        }), {
          title: tGlobal("commands.openWorkspace.failed.title"),
          variant: "error",
        })
      }
    }

    commandRegistry.register({
      id: "new-instance",
      label: () => tGlobal("commands.newInstance.label"),
      description: () => tGlobal("commands.newInstance.description"),
      category: "Instance",
      keywords: () => splitKeywords("commands.newInstance.keywords"),
      shortcut: { key: "N", meta: true },
      action: options.handleNewInstanceRequest,
    })

    commandRegistry.register({
      id: "close-instance",
      label: () => tGlobal("commands.closeInstance.label"),
      description: () => tGlobal("commands.closeInstance.description"),
      category: "Instance",
      keywords: () => splitKeywords("commands.closeInstance.keywords"),
      shortcut: { key: "W", meta: true },
      action: async () => {
        await options.handleCloseActiveTab()
      },
    })

    commandRegistry.register({
      id: "stop-instance",
      label: () => tGlobal("commands.stopInstance.label"),
      description: () => tGlobal("commands.stopInstance.description"),
      category: "Instance",
      keywords: () => splitKeywords("commands.stopInstance.keywords"),
      disabled: () => !activeInstance(),
      action: async () => {
        const instance = activeInstance()
        if (instance) await options.handleStopInstance(instance.id)
      },
    })

    if (canOpenWorkspacePaths()) {
      commandRegistry.register({
        id: "open-workspace-folder",
        label: () => tGlobal("commands.openWorkspace.folder.label"),
        description: () => tGlobal("commands.openWorkspace.folder.description"),
        category: "Instance",
        keywords: () => splitKeywords("commands.openWorkspace.folder.keywords"),
        disabled: () => !activeInstance(),
        action: () => openActiveWorkspace("default"),
      })
      commandRegistry.register({
        id: "open-workspace-terminal",
        label: () => tGlobal("commands.openWorkspace.terminal.label"),
        description: () => tGlobal("commands.openWorkspace.terminal.description"),
        category: "Instance",
        keywords: () => splitKeywords("commands.openWorkspace.terminal.keywords"),
        disabled: () => !activeInstance(),
        action: () => openActiveWorkspace("terminal"),
      })
      const editors: Array<[WorkspaceEditor, string]> = [
        ["vscode", "VS Code"],
        ["cursor", "Cursor"],
        ["zed", "Zed"],
        ["vscodium", "VSCodium"],
      ]
      for (const [editor, name] of editors) {
        commandRegistry.register({
          id: `open-workspace-editor-${editor}`,
          label: () => tGlobal("commands.openWorkspace.editor.label", { editor: name }),
          description: () => tGlobal("commands.openWorkspace.editor.description", { editor: name }),
          category: "Instance",
          keywords: () => [name, ...splitKeywords("commands.openWorkspace.editor.keywords")],
          disabled: () => !activeInstance(),
          action: () => openActiveWorkspace("editor", editor),
        })
      }
    }

    commandRegistry.register({
      id: "instance-next",
      label: () => tGlobal("commands.nextInstance.label"),
      description: () => tGlobal("commands.nextInstance.description"),
      category: "Instance",
      keywords: () => splitKeywords("commands.nextInstance.keywords"),
      shortcut: { key: "]", meta: true },
      action: () => selectNextAppTab(),
    })

    commandRegistry.register({
      id: "instance-prev",
      label: () => tGlobal("commands.previousInstance.label"),
      description: () => tGlobal("commands.previousInstance.description"),
      category: "Instance",
      keywords: () => splitKeywords("commands.previousInstance.keywords"),
      shortcut: { key: "[", meta: true },
      action: () => selectPreviousAppTab(),
    })

    commandRegistry.register({
      id: "new-session",
      label: () => tGlobal("commands.newSession.label"),
      description: () => tGlobal("commands.newSession.description"),
      category: "Session",
      keywords: () => splitKeywords("commands.newSession.keywords"),
      shortcut: { key: "N", meta: true, shift: true },
      action: async () => {
        const instance = activeInstance()
        if (!instance) return
        await options.handleNewSession(instance.id)
      },
    })

    commandRegistry.register({
      id: "close-session",
      label: () => tGlobal("commands.closeSession.label"),
      description: () => tGlobal("commands.closeSession.description"),
      category: "Session",
      keywords: () => splitKeywords("commands.closeSession.keywords"),
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
      label: () => tGlobal("commands.scrubSessions.label"),
      description: () => tGlobal("commands.scrubSessions.description"),
      category: "Session",
      keywords: () => splitKeywords("commands.scrubSessions.keywords"),
      action: async () => {
        const instance = activeInstance()
        if (!instance) return
        cleanupBlankSessions(instance.id, undefined, true)
      },
    })

    commandRegistry.register({
      id: "switch-to-info",
      label: () => tGlobal("commands.instanceInfo.label"),
      description: () => tGlobal("commands.instanceInfo.description"),
      category: "Instance",
      keywords: () => splitKeywords("commands.instanceInfo.keywords"),
      shortcut: { key: "L", meta: true, shift: true },
      action: () => {
        const instance = activeInstance()
        if (instance) setActiveSession(instance.id, "info")
      },
    })

    commandRegistry.register({
      id: "session-next",
      label: () => tGlobal("commands.nextSession.label"),
      description: () => tGlobal("commands.nextSession.description"),
      category: "Session",
      keywords: () => splitKeywords("commands.nextSession.keywords"),
      shortcut: { key: "]", meta: true, shift: true },
      action: () => {
        const instanceId = activeInstanceId()
        if (!instanceId) return
        const ids = getVisibleSessionIds(instanceId)
        if (ids.length <= 1) return

        const currentActiveId = activeSessionIdForInstance() ?? ""
        const currentIndex = ids.indexOf(currentActiveId)
        const targetIndex = (currentIndex + 1 + ids.length) % ids.length

        const targetSessionId = ids[targetIndex]
        if (targetSessionId) {
          setActiveSessionFromList(instanceId, targetSessionId)
          emitSessionSidebarRequest({ instanceId, action: "show-session-list" })
        }
      },
    })

    commandRegistry.register({
      id: "session-prev",
      label: () => tGlobal("commands.previousSession.label"),
      description: () => tGlobal("commands.previousSession.description"),
      category: "Session",
      keywords: () => splitKeywords("commands.previousSession.keywords"),
      shortcut: { key: "[", meta: true, shift: true },
      action: () => {
        const instanceId = activeInstanceId()
        if (!instanceId) return
        const ids = getVisibleSessionIds(instanceId)
        if (ids.length <= 1) return

        const currentActiveId = activeSessionIdForInstance() ?? ""
        const currentIndex = ids.indexOf(currentActiveId)
        const targetIndex =
          currentIndex === -1 ? ids.length - 1 : currentIndex <= 0 ? ids.length - 1 : currentIndex - 1

        const targetSessionId = ids[targetIndex]
        if (targetSessionId) {
          setActiveSessionFromList(instanceId, targetSessionId)
          emitSessionSidebarRequest({ instanceId, action: "show-session-list" })
        }
      },
    })

    commandRegistry.register({
      id: "compact",
      label: () => tGlobal("commands.compactSession.label"),
      description: () => tGlobal("commands.compactSession.description"),
      category: "Session",
      keywords: () => ["/compact", ...splitKeywords("commands.compactSession.keywords")],
      action: async () => {
        const instance = activeInstance()
        const sessionId = activeSessionIdForInstance()
        if (!instance || !instance.client || !sessionId || sessionId === "info") return

        const sessions = getSessions(instance.id)
        const session = sessions.find((s) => s.id === sessionId)
        if (!session) return

        try {
          await compactSession(instance.id, sessionId)
        } catch (error) {
          log.error("Failed to compact session", error)
          const message = error instanceof Error ? error.message : tGlobal("commands.compactSession.errorFallback")
          showAlertDialog(tGlobal("commands.compactSession.alert.message", { message }), {
            title: tGlobal("commands.compactSession.alert.title"),
            variant: "error",
          })
        }

      },
    })

    commandRegistry.register({
      id: "remove-session-tools-and-reasoning",
      label: () => tGlobal("commands.removeSessionTechnicalParts.label"),
      description: () => tGlobal("commands.removeSessionTechnicalParts.description"),
      category: "Session",
      keywords: () => splitKeywords("commands.removeSessionTechnicalParts.keywords"),
      disabled: () => {
        const sessionId = activeSessionIdForInstance()
        return !activeInstance() || !sessionId || sessionId === "info"
      },
      action: async () => {
        const instance = activeInstance()
        const sessionId = activeSessionIdForInstance()
        if (!instance || !sessionId || sessionId === "info") return
        try {
          const plan = await planSessionTechnicalPartDeletion(instance.id, sessionId)
          if (plan.messageIds.length === 0) {
            showAlertDialog(tGlobal("commands.removeSessionTechnicalParts.empty.message"), {
              title: tGlobal("commands.removeSessionTechnicalParts.empty.title"),
              variant: "info",
            })
            return
          }
          const confirmed = await showConfirmDialog(tGlobal("commands.removeSessionTechnicalParts.confirm.message", {
            toolCount: plan.toolCount,
            reasoningCount: plan.reasoningCount,
          }), {
            title: tGlobal("commands.removeSessionTechnicalParts.confirm.title"),
            confirmLabel: tGlobal("commands.removeSessionTechnicalParts.confirm.label"),
            variant: "warning",
          })
          if (!confirmed) return
          const failed = await executeSessionTechnicalPartDeletion(plan)
          if (failed > 0) {
            showAlertDialog(tGlobal("commands.removeSessionTechnicalParts.failed.message", { count: failed }), {
              title: tGlobal("commands.removeSessionTechnicalParts.failed.title"),
              variant: "error",
            })
          }
        } catch (error) {
          showAlertDialog(error instanceof Error ? error.message : String(error), {
            title: tGlobal("commands.removeSessionTechnicalParts.failed.title"),
            variant: "error",
          })
        }
      },
    })

    function escapeCss(value: string) {
      if (typeof CSS !== "undefined" && typeof (CSS as any).escape === "function") {
        return (CSS as any).escape(value)
      }
      return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")
    }

    function findVisiblePromptTextarea(sessionId?: string): HTMLTextAreaElement | null {
      if (typeof document === "undefined") return null
      const base = ".session-cache-pane[aria-hidden=\"false\"]"
      const selector = sessionId
        ? `${base}[data-session-id=\"${escapeCss(sessionId)}\"] .prompt-input`
        : `${base} .prompt-input`
      return document.querySelector(selector) as HTMLTextAreaElement | null
    }

    commandRegistry.register({
      id: "undo",
      label: () => tGlobal("commands.undoLastMessage.label"),
      description: () => tGlobal("commands.undoLastMessage.description"),
      category: "Session",
      keywords: () => ["/undo", ...splitKeywords("commands.undoLastMessage.keywords")],
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
          showAlertDialog(tGlobal("commands.undoLastMessage.none.message"), {
            title: tGlobal("commands.undoLastMessage.none.title"),
            variant: "info",
          })
          return
        }

        try {
          await instance.client.session.revert.stage({ sessionID: sessionId, messageID })

          if (!restoredText) {
            const fallbackRecord = store.getMessage(messageID)
            restoredText = extractUserTextFromRecord(fallbackRecord)
          }

          if (restoredText) {
            const textarea = findVisiblePromptTextarea(sessionId)
            if (textarea) {
              textarea.value = restoredText
              textarea.dispatchEvent(new Event("input", { bubbles: true }))
              textarea.focus()
            }
          }
        } catch (error) {
          log.error("Failed to revert message", error)
          showAlertDialog(tGlobal("commands.undoLastMessage.failed.message"), {
            title: tGlobal("commands.undoLastMessage.failed.title"),
            variant: "error",
          })
        }

      },
    })

    commandRegistry.register({
      id: "redo",
      label: () => tGlobal("commands.redoLastMessage.label"),
      description: () => tGlobal("commands.redoLastMessage.description"),
      category: "Session",
      keywords: () => ["/redo", ...splitKeywords("commands.redoLastMessage.keywords")],
      disabled: () => {
        const instance = activeInstance()
        const sessionId = activeSessionIdForInstance()
        if (!instance || !sessionId || sessionId === "info") return true
        const session = getSessions(instance.id).find((candidate) => candidate.id === sessionId)
        return !(messageStoreBus.getOrCreate(instance.id).getSessionRevert(sessionId) ?? session?.revert)
      },
      action: async () => {
        const instance = activeInstance()
        const sessionId = activeSessionIdForInstance()
        if (!instance?.client || !sessionId || sessionId === "info") return
        try {
          await instance.client.session.revert.clear({ sessionID: sessionId })
        } catch (error) {
          log.error("Failed to clear session revert", error)
          showAlertDialog(tGlobal("commands.redoLastMessage.failed.message"), {
            title: tGlobal("commands.redoLastMessage.failed.title"),
            variant: "error",
          })
        }
      },
    })

    commandRegistry.register({
      id: "open-model-selector",
      label: () => tGlobal("commands.openModelSelector.label"),
      description: () => tGlobal("commands.openModelSelector.description"),
      category: "Agent & Model",
      keywords: () => splitKeywords("commands.openModelSelector.keywords"),
      shortcut: { key: "M", meta: true, shift: true },
      action: () => {
        const instance = activeInstance()
        if (!instance) return
        emitSessionSidebarRequest({ instanceId: instance.id, action: "focus-model-selector" })
      },
    })

    commandRegistry.register({
      id: "open-variant-selector",
      label: () => tGlobal("commands.selectModelVariant.label"),
      description: () => tGlobal("commands.selectModelVariant.description"),
      category: "Agent & Model",
      keywords: () => splitKeywords("commands.selectModelVariant.keywords"),
      shortcut: { key: "T", meta: true, shift: true },
      action: () => {
        const instance = activeInstance()
        if (!instance) return
        emitSessionSidebarRequest({ instanceId: instance.id, action: "focus-variant-selector" })
      },
    })

    commandRegistry.register({
      id: "open-agent-selector",
      label: () => tGlobal("commands.openAgentSelector.label"),
      description: () => tGlobal("commands.openAgentSelector.description"),
      category: "Agent & Model",
      keywords: () => splitKeywords("commands.openAgentSelector.keywords"),
      shortcut: { key: "A", meta: true, shift: true },
      action: () => {
        const instance = activeInstance()
        if (!instance) return
        emitSessionSidebarRequest({ instanceId: instance.id, action: "focus-agent-selector" })
      },
    })

    commandRegistry.register({
      id: "clear-input",
      label: () => tGlobal("commands.clearInput.label"),
      description: () => tGlobal("commands.clearInput.description"),
      category: "Input & Focus",
      keywords: () => splitKeywords("commands.clearInput.keywords"),
      shortcut: { key: "K", meta: true },
      action: () => {
        const textarea = findVisiblePromptTextarea()
        if (textarea) textarea.value = ""
      },
    })

    registerBehaviorCommands((command) => commandRegistry.register(command), {
      preferences: options.preferences,
      toggleShowThinkingBlocks: options.toggleShowThinkingBlocks,
      toggleKeyboardShortcutHints: options.toggleKeyboardShortcutHints,
      toggleShowMessageTimeline: options.toggleShowMessageTimeline,
      toggleShowTimelineTools: options.toggleShowTimelineTools,
      toggleUsageMetrics: options.toggleUsageMetrics,
      toggleAutoCleanupBlankSessions: options.toggleAutoCleanupBlankSessions,
      togglePromptSubmitOnEnter: options.togglePromptSubmitOnEnter,
      toggleShowPromptVoiceInput: options.toggleShowPromptVoiceInput,
      setDiffViewMode: options.setDiffViewMode,
      setToolOutputExpansion: options.setToolOutputExpansion,
      setDiagnosticsExpansion: options.setDiagnosticsExpansion,
      setThinkingBlocksExpansion: options.setThinkingBlocksExpansion,
      setToolInputsVisibility: options.setToolInputsVisibility,
    })
 
    commandRegistry.register({
      id: "help",
      label: () => tGlobal("commands.showHelp.label"),
      description: () => tGlobal("commands.showHelp.description"),
      category: "System",
      keywords: () => ["/help", ...splitKeywords("commands.showHelp.keywords")],
      action: () => {
        log.info("Show help modal (not implemented)")
      },
    })
  }

  function executeCommand(command: Command) {
    try {
      const result = command.action?.()
      if (result instanceof Promise) {
        void result.catch((error) => {
          log.error("Command execution failed", error)
        })
      }
    } catch (error) {
      log.error("Command execution failed", error)
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
