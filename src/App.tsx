import { Component, onMount, onCleanup, Show, createMemo, createEffect, createSignal } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"
import { Toaster } from "solid-toast"
import type { Session } from "./types/session"
import type { Attachment } from "./types/attachment"
import type { SDKPart, ClientPart } from "./types/message"
import type { Permission } from "@opencode-ai/sdk"
import FolderSelectionView from "./components/folder-selection-view"
import InstanceWelcomeView from "./components/instance-welcome-view"
import CommandPalette from "./components/command-palette"
import InstanceTabs from "./components/instance-tabs"
import SessionList from "./components/session-list"
import MessageStream from "./components/message-stream"
import PromptInput from "./components/prompt-input"
import InfoView from "./components/info-view"
import AgentSelector from "./components/agent-selector"
import ModelSelector from "./components/model-selector"
import KeyboardHint from "./components/keyboard-hint"
import InstanceDisconnectedModal from "./components/instance-disconnected-modal"
import { initMarkdown } from "./lib/markdown"
import { useTheme } from "./lib/theme"
import { createCommandRegistry } from "./lib/commands"
import type { Command } from "./lib/commands"
import {
  hasInstances,
  isSelectingFolder,
  setIsSelectingFolder,
  setHasInstances,
  showFolderSelection,
  setShowFolderSelection,
} from "./stores/ui"
import { useConfig } from "./stores/preferences"
import {
  createInstance,
  instances,
  updateInstance,
  activeInstanceId,
  setActiveInstanceId,
  stopInstance,
  getActiveInstance,
  addLog,
  getActivePermission,
  sendPermissionResponse,
  disconnectedInstance,
  acknowledgeDisconnectedInstance,
} from "./stores/instances"
import {
  getSessions,
  activeSessionId,
  setActiveSession,
  setActiveParentSession,
  clearActiveParentSession,
  createSession,
  forkSession,
  deleteSession,
  getSessionFamily,
  activeParentSessionId,
  getParentSessions,
  loadMessages,
  sendMessage,
  abortSession,
  updateSessionAgent,
  updateSessionModel,
  agents,
  getSessionInfo,
  isSessionMessagesLoading,
  fetchSessions,
} from "./stores/sessions"
import { isSessionBusy } from "./stores/session-status"
import { setupTabKeyboardShortcuts } from "./lib/keyboard"
import { isOpen as isCommandPaletteOpen, showCommandPalette, hideCommandPalette } from "./stores/command-palette"
import { registerNavigationShortcuts } from "./lib/shortcuts/navigation"
import { registerInputShortcuts } from "./lib/shortcuts/input"
import { registerAgentShortcuts } from "./lib/shortcuts/agent"
import { registerEscapeShortcut, setEscapeStateChangeHandler } from "./lib/shortcuts/escape"
import { keyboardRegistry } from "./lib/keyboard-registry"
import type { KeyboardShortcut } from "./lib/keyboard-registry"
import { setSessionCompactionState } from "./stores/session-compaction"

const SessionView: Component<{
  sessionId: string
  activeSessions: Map<string, Session>
  instanceId: string
  instanceFolder: string
  escapeInDebounce: boolean
}> = (props) => {
  const session = () => props.activeSessions.get(props.sessionId)
  const messagesLoading = createMemo(() => isSessionMessagesLoading(props.instanceId, props.sessionId))
 
  createEffect(() => {

    const currentSession = session()
    if (currentSession) {
      loadMessages(props.instanceId, currentSession.id).catch(console.error)
    }
  })

  async function handleSendMessage(prompt: string, attachments: Attachment[]) {
    await sendMessage(props.instanceId, props.sessionId, prompt, attachments)
  }
 
  function getUserMessageText(messageId: string): string | null {
    const currentSession = session()
    if (!currentSession) return null
 
    const targetMessage = currentSession.messages.find((m) => m.id === messageId)
    const targetInfo = currentSession.messagesInfo.get(messageId)
    if (!targetMessage || targetInfo?.role !== "user") {
      return null
    }
 
    const textParts = targetMessage.parts.filter((p): p is ClientPart & { type: "text"; text: string } => p.type === "text")
    if (textParts.length === 0) {
      return null
    }
 
    return textParts.map((p) => p.text).join("\n")
  }
 
  async function handleRevert(messageId: string) {

    const instance = instances().get(props.instanceId)
    if (!instance || !instance.client) return

    try {
      console.log("Reverting to message:", messageId)

      await instance.client.session.revert({
        path: { id: props.sessionId },
        body: { messageID: messageId },
      })

      const restoredText = getUserMessageText(messageId)
      if (restoredText) {
        const textarea = document.querySelector(".prompt-input") as HTMLTextAreaElement
        if (textarea) {
          textarea.value = restoredText
          textarea.dispatchEvent(new Event("input", { bubbles: true }))
          textarea.focus()
        }
      }


      console.log("Reverted to message - UI will update via SSE")
    } catch (error) {
      console.error("Failed to revert:", error)
      alert("Failed to revert to message")
    }
  }

  async function handleFork(messageId?: string) {
    if (!messageId) {
      console.warn("Fork requires a user message id")
      return
    }
 
    const restoredText = getUserMessageText(messageId)
 
    try {
      const forkedSession = await forkSession(props.instanceId, props.sessionId, { messageId })
 
      const parentToActivate = forkedSession.parentId ?? forkedSession.id
      setActiveParentSession(props.instanceId, parentToActivate)
      if (forkedSession.parentId) {
        setActiveSession(props.instanceId, forkedSession.id)
      }
 
      await loadMessages(props.instanceId, forkedSession.id).catch(console.error)
 
      if (restoredText) {
        const textarea = document.querySelector(".prompt-input") as HTMLTextAreaElement
        if (textarea) {
          textarea.value = restoredText
          textarea.dispatchEvent(new Event("input", { bubbles: true }))
          textarea.focus()
        }
      }
    } catch (error) {
      console.error("Failed to fork session:", error)
      alert("Failed to fork session")
    }
  }


  const activePermission = createMemo(() => getActivePermission(props.instanceId))

  async function handlePermissionResponse(response: "once" | "always" | "reject") {
    const permission = activePermission()
    if (!permission) return

    try {
      await sendPermissionResponse(props.instanceId, props.sessionId, permission.id, response)
    } catch (error) {
      console.error("Failed to send permission response:", error)
    }
  }

  // Handle permission keyboard shortcuts
  createEffect(() => {
    const permission = activePermission()
    if (!permission) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault()
        handlePermissionResponse("once")
      } else if (event.key === "a" || event.key === "A") {
        event.preventDefault()
        handlePermissionResponse("always")
      } else if (event.key === "d" || event.key === "D") {
        event.preventDefault()
        handlePermissionResponse("reject")
      }
    }

    document.addEventListener("keydown", handleKeyDown)
    onCleanup(() => document.removeEventListener("keydown", handleKeyDown))
  })

  return (
    <Show
      when={session()}
      fallback={
        <div class="flex items-center justify-center h-full">
          <div class="text-center text-gray-500">Session not found</div>
        </div>
      }
    >
      {(s) => (
        <div class="session-view">
          <MessageStream
            instanceId={props.instanceId}
            sessionId={s().id}
            messages={s().messages || []}
            messagesInfo={s().messagesInfo}
            revert={s().revert}
            loading={messagesLoading()}
            onRevert={handleRevert}
            onFork={handleFork}
          />

          <Show when={activePermission()}>
            {(permission) => (
              <div class="permission-dialog border-2 border-[var(--status-warning)] bg-surface-secondary p-4 mx-4 mb-4 rounded-lg shadow-lg">
                <div class="flex items-start gap-3">
                  <div class="flex-shrink-0">
                    <div class="w-6 h-6 bg-[var(--status-warning)] rounded-full flex items-center justify-center">
                      <svg class="w-4 h-4 text-[var(--text-inverted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
                      </svg>
                    </div>
                  </div>
                  <div class="flex-1">
                    <div class="mb-2">
                      <span class="font-semibold text-primary">Permission Required</span>
                      <span class="ml-2 font-mono text-sm bg-surface-secondary border border-base rounded px-1.5 py-0.5">{permission().type}</span>
                    </div>
                    <div class="bg-surface-code p-3 rounded border mb-3">
                      <code class="text-sm text-primary">{permission().title}</code>
                    </div>
                    <div class="flex gap-2 text-sm">
                      <kbd class="kbd">Enter</kbd>
                      <span class="text-muted">Accept once</span>
                      <kbd class="kbd ml-4">a</kbd>
                      <span class="text-muted">Accept always</span>
                      <kbd class="kbd ml-4">d</kbd>
                      <span class="text-muted">Deny</span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </Show>

          <PromptInput
            instanceId={props.instanceId}
            instanceFolder={props.instanceFolder}
            sessionId={s().id}
            onSend={handleSendMessage}
            escapeInDebounce={props.escapeInDebounce}
          />
        </div>
      )}
    </Show>
  )
}

const formatTokenTotal = (value: number) => {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(0)}K`
  }
  return value.toLocaleString()
}

const ContextUsagePanel: Component<{ instanceId: string; sessionId: string }> = (props) => {
  const info = createMemo(
    () =>
      getSessionInfo(props.instanceId, props.sessionId) ?? {
        tokens: 0,
        cost: 0,
        contextWindow: 0,
        isSubscriptionModel: false,
        contextUsageTokens: 0,
        contextUsagePercent: null,
      },
  )

  const tokens = createMemo(() => info().tokens)
  const contextUsageTokens = createMemo(() => info().contextUsageTokens ?? 0)
  const contextWindow = createMemo(() => info().contextWindow)
  const contextUsagePercent = createMemo(() => info().contextUsagePercent)

  const costLabel = createMemo(() => {
    if (info().isSubscriptionModel || info().cost <= 0) return "Included in plan"
    return `$${info().cost.toFixed(2)} spent`
  })

  return (
    <div class="session-context-panel border-r border-base border-b px-3 py-3">
      <div class="flex items-center justify-between gap-4">
        <div>
          <div class="text-xs font-semibold text-primary/70 uppercase tracking-wide">Tokens (last call)</div>
          <div class="text-lg font-semibold text-primary">{formatTokenTotal(tokens())}</div>
        </div>
        <div class="text-xs text-primary/70 text-right leading-tight">{costLabel()}</div>
      </div>
      <div class="mt-4">
        <div class="flex items-center justify-between mb-1">
          <div class="text-xs font-semibold text-primary/70 uppercase tracking-wide">Context window usage</div>
          <div class="text-sm font-medium text-primary">{contextUsagePercent() !== null ? `${contextUsagePercent()}%` : "--"}</div>
        </div>
        <div class="text-sm text-primary/90">
          {contextWindow()
            ? `${formatTokenTotal(contextUsageTokens())} of ${formatTokenTotal(contextWindow())}`
            : "Window size unavailable"}
        </div>
      </div>
      <div class="mt-3 h-1.5 rounded-full bg-base relative overflow-hidden">
        <div
          class="absolute inset-y-0 left-0 rounded-full bg-accent-primary transition-[width]"
          style={{ width: contextUsagePercent() === null ? "0%" : `${contextUsagePercent()}%` }}
        />
      </div>
    </div>
  )
}

const App: Component = () => {
  const { isDark } = useTheme()
  const { preferences, addRecentFolder, toggleShowThinkingBlocks, setDiffViewMode } = useConfig()
  const commandRegistry = createCommandRegistry()
  const [escapeInDebounce, setEscapeInDebounce] = createSignal(false)
  const [paletteCommands, setPaletteCommands] = createSignal<Command[]>([])
  const [launchErrorBinary, setLaunchErrorBinary] = createSignal<string | null>(null)
  const [isAdvancedSettingsOpen, setIsAdvancedSettingsOpen] = createSignal(false)

  const launchErrorPath = () => {
    const value = launchErrorBinary()
    if (!value) return "opencode"
    return value.trim() || "opencode"
  }

  const isMissingBinaryError = (error: unknown): boolean => {
    if (!error) return false
    const message = typeof error === "string" ? error : error instanceof Error ? error.message : String(error)
    const normalized = message.toLowerCase()
    return (
      normalized.includes("opencode binary not found") ||
      normalized.includes("binary not found") ||
      normalized.includes("no such file or directory") ||
      normalized.includes("binary is not executable") ||
      normalized.includes("enoent")
    )
  }

  const clearLaunchError = () => setLaunchErrorBinary(null)

  const refreshCommandPalette = () => {
    setPaletteCommands(commandRegistry.getAll())
  }

  createEffect(() => {
    void initMarkdown(isDark()).catch(console.error)
  })

  const activeInstance = createMemo(() => getActiveInstance())

  const activeSessions = createMemo(() => {
    const instance = activeInstance()
    if (!instance) return new Map()
    const instanceId = instance.id
    const parentId = activeParentSessionId().get(instanceId)
    if (!parentId) return new Map()

    const sessionFamily = getSessionFamily(instanceId, parentId)
    return new Map(sessionFamily.map((s) => [s.id, s]))
  })

  const activeSessionIdForInstance = createMemo(() => {
    const instance = activeInstance()
    if (!instance) return null
    return activeSessionId().get(instance.id) || null
  })


  const activeSessionForInstance = createMemo(() => {
    const sessionId = activeSessionIdForInstance()
    if (!sessionId || sessionId === "info") return null
    return activeSessions().get(sessionId) ?? null
  })

  const handleSidebarAgentChange = async (agent: string) => {
    const instance = activeInstance()
    const sessionId = activeSessionIdForInstance()
    if (!instance || !sessionId || sessionId === "info") return
    await updateSessionAgent(instance.id, sessionId, agent)
  }

  const handleSidebarModelChange = async (model: { providerId: string; modelId: string }) => {
    const instance = activeInstance()
    const sessionId = activeSessionIdForInstance()
    if (!instance || !sessionId || sessionId === "info") return
    await updateSessionModel(instance.id, sessionId, model)
  }

  const DEFAULT_SESSION_SIDEBAR_WIDTH = 280
  const [sessionSidebarWidth, setSessionSidebarWidth] = createSignal(DEFAULT_SESSION_SIDEBAR_WIDTH)

  async function handleSelectFolder(folderPath?: string, binaryPath?: string) {
    setIsSelectingFolder(true)
    const selectedBinary = binaryPath || preferences().lastUsedBinary || "opencode"
    try {
      let folder: string | null | undefined = folderPath

      if (!folder) {
        folder = await window.electronAPI.selectFolder()
        if (!folder) {
          return
        }
      }

      if (!folder) {
        return
      }

      addRecentFolder(folder)
      clearLaunchError()
      const instanceId = await createInstance(folder, selectedBinary)
      setHasInstances(true)
      setShowFolderSelection(false)
      setIsAdvancedSettingsOpen(false)

      console.log("Created instance:", instanceId, "Port:", instances().get(instanceId)?.port)
    } catch (error) {
      clearLaunchError()
      if (isMissingBinaryError(error)) {
        setLaunchErrorBinary(selectedBinary)
      }
      console.error("Failed to create instance:", error)
    } finally {
      setIsSelectingFolder(false)
    }
  }

  function handleLaunchErrorClose() {
    clearLaunchError()
  }

  function handleLaunchErrorAdvanced() {
    clearLaunchError()
    setIsAdvancedSettingsOpen(true)
  }

  function handleNewInstanceRequest() {
    if (hasInstances()) {
      setShowFolderSelection(true)
    } else {
      handleSelectFolder()
    }
  }

  async function handleDisconnectedInstanceClose() {
    try {
      await acknowledgeDisconnectedInstance()
    } catch (error) {
      console.error("Failed to finalize disconnected instance:", error)
    }
  }

  async function handleCloseInstance(instanceId: string) {
    if (confirm("Stop OpenCode instance? This will stop the server.")) {
      await stopInstance(instanceId)
      if (instances().size === 0) {
        setHasInstances(false)
      }
    }
  }

  async function handleNewSession(instanceId: string) {
    try {
      const session = await createSession(instanceId)
      setActiveParentSession(instanceId, session.id)
    } catch (error) {
      console.error("Failed to create session:", error)
    }
  }

  async function handleCloseSession(instanceId: string, sessionId: string) {
    const sessions = getSessions(instanceId)
    const session = sessions.find((s) => s.id === sessionId)

    if (!session) {
      return
    }

    const parentSessionId = session.parentId ?? session.id
    const parentSession = sessions.find((s) => s.id === parentSessionId)

    if (!parentSession || parentSession.parentId !== null) {
      return
    }

    clearActiveParentSession(instanceId)

    try {
      await fetchSessions(instanceId)
    } catch (error) {
      console.error("Failed to refresh sessions after closing:", error)
    }
  }

  function setupCommands() {
    commandRegistry.register({
      id: "new-instance",
      label: "New Instance",
      description: "Open folder picker to create new instance",
      category: "Instance",
      keywords: ["folder", "project", "workspace"],
      shortcut: { key: "N", meta: true },
      action: handleNewInstanceRequest,
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
        await handleCloseInstance(instance.id)
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
        await handleNewSession(instance.id)
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
        await handleCloseSession(instance.id, sessionId)
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
        const current = ids.indexOf(activeSessionId().get(instanceId) || "")
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
        const current = ids.indexOf(activeSessionId().get(instanceId) || "")
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
          console.log("Compacting session...")
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
          alert(`Compact failed: ${message}`)
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

        // Find the message to revert to (previous user message before revert point)
        let after = 0
        const revert = session.revert

        if (revert?.messageID) {
          // Find the timestamp of the revert point
          for (let i = session.messages.length - 1; i >= 0; i--) {
            const msg = session.messages[i]
            const info = session.messagesInfo.get(msg.id)
            if (info?.id === revert.messageID) {
              after = info.time?.created || 0
              break
            }
          }
        }

        // Find the previous user message
        let messageID = ""
        for (let i = session.messages.length - 1; i >= 0; i--) {
          const msg = session.messages[i]
          const info = session.messagesInfo.get(msg.id)

          if (msg.type === "user" && info?.time?.created) {
            if (after > 0 && info.time.created >= after) {
              continue
            }
            messageID = msg.id
            break
          }
        }

        if (!messageID) {
          alert("Nothing to undo")
          return
        }

        try {
          // Find the reverted message to restore to input
          const revertedMessage = session.messages.find((m) => m.id === messageID)
          const revertedInfo = session.messagesInfo.get(messageID)

          console.log("Reverting to message:", messageID)

          await instance.client.session.revert({
            path: { id: sessionId },
            body: { messageID },
          })

          console.log("Revert API call completed")

          // Restore the reverted user message to the prompt input
          if (revertedMessage && revertedInfo?.role === "user") {
            const textParts = revertedMessage.parts.filter((p): p is ClientPart & { type: "text"; text: string } => p.type === "text")
            if (textParts.length > 0) {
              const textarea = document.querySelector(".prompt-input") as HTMLTextAreaElement
              if (textarea) {
                textarea.value = textParts.map((p) => p.text).join("\n")
                textarea.dispatchEvent(new Event("input", { bubbles: true }))
                textarea.focus()
              }
            }
          }

          console.log("Last message reverted - UI will update via SSE")
        } catch (error) {
          console.error("Failed to revert message:", error)
          alert("Failed to revert message")
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
      id: "init",
      label: "Initialize AGENTS.md",
      description: "Create or update AGENTS.md file",
      category: "Agent & Model",
      keywords: ["/init", "agents", "initialize"],
      action: async () => {
        const instance = activeInstance()
        const sessionId = activeSessionIdForInstance()
        if (!instance || !instance.client || !sessionId || sessionId === "info") return

        const sessions = getSessions(instance.id)
        const session = sessions.find((s) => s.id === sessionId)
        if (!session) return

        try {
          // Generate ID similar to server format: timestamp in hex + random chars
          const timestamp = Date.now()
          const timePart = (timestamp * 0x1000).toString(16).padStart(12, "0")
          const randomPart = Math.random().toString(16).substring(2, 16)
          const messageID = `msg_${timePart}${randomPart}`

          await instance.client.session.init({
            path: { id: sessionId },
            body: {
              messageID,
              providerID: session.model.providerId,
              modelID: session.model.modelId,
            },
          })
          console.log("Initializing AGENTS.md...")
        } catch (error) {
          console.error("Failed to initialize AGENTS.md:", error)
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
      label: () => `${preferences().showThinkingBlocks ? "Hide" : "Show"} Thinking Blocks`,
      description: "Show/hide AI thinking process",
      category: "System",
      keywords: ["/thinking", "toggle", "show", "hide"],
      action: toggleShowThinkingBlocks,
    })

    commandRegistry.register({
      id: "diff-view-split",
      label: () => `${(preferences().diffViewMode || "split") === "split" ? "✓ " : ""}Use Split Diff View`,
      description: "Display tool-call diffs side-by-side",
      category: "System",
      keywords: ["diff", "split", "view"],
      action: () => setDiffViewMode("split"),
    })

    commandRegistry.register({
      id: "diff-view-unified",
      label: () => `${(preferences().diffViewMode || "split") === "unified" ? "✓ " : ""}Use Unified Diff View`,
      description: "Display tool-call diffs inline",
      category: "System",
      keywords: ["diff", "unified", "view"],
      action: () => setDiffViewMode("unified"),
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

    refreshCommandPalette()
  }

  function handleExecuteCommand(commandId: string) {
    commandRegistry.execute(commandId)
  }



  onMount(() => {
    setEscapeStateChangeHandler(setEscapeInDebounce)

    setupCommands()

    setupTabKeyboardShortcuts(
      handleNewInstanceRequest,
      handleCloseInstance,
      handleNewSession,
      handleCloseSession,
      showCommandPalette,
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
        if (showFolderSelection()) return true

        const instance = activeInstance()
        if (!instance) return false

        const sessionId = activeSessionIdForInstance()
        if (!sessionId || sessionId === "info") return false

        const sessions = getSessions(instance.id)
        const session = sessions.find((s) => s.id === sessionId)
        if (!session) return false

        return isSessionBusy(instance.id, sessionId)
      },
      async () => {
        if (showFolderSelection()) {
          setShowFolderSelection(false)
          return
        }

        const instance = activeInstance()
        const sessionId = activeSessionIdForInstance()
        if (!instance || !sessionId || sessionId === "info") return

        try {
          await abortSession(instance.id, sessionId)
          console.log("Session aborted successfully")
        } catch (error) {
          console.error("Failed to abort session:", error)
        }
      },
      () => {
        const active = document.activeElement as HTMLElement
        active?.blur()
      },
      hideCommandPalette,
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

    window.electronAPI.onNewInstance(() => {
      handleNewInstanceRequest()
    })

    window.electronAPI.onInstanceStarted(({ id, port, pid, binaryPath }) => {
      console.log("Instance started:", { id, port, pid, binaryPath })
      updateInstance(id, { port, pid, status: "ready", binaryPath })
    })

    window.electronAPI.onInstanceError(({ id, error }) => {
      console.error("Instance error:", { id, error })
      updateInstance(id, { status: "error", error })
    })

    window.electronAPI.onInstanceStopped(({ id }) => {
      console.log("Instance stopped:", id)
      updateInstance(id, { status: "stopped" })
    })

    window.electronAPI.onInstanceLog(({ id, entry }) => {
      addLog(id, entry)
    })
  })

  return (
    <>
      <InstanceDisconnectedModal
        open={Boolean(disconnectedInstance())}
        folder={disconnectedInstance()?.folder}
        reason={disconnectedInstance()?.reason}
        onClose={handleDisconnectedInstanceClose}
      />

      <Dialog open={Boolean(launchErrorBinary())} modal>
        <Dialog.Portal>
          <Dialog.Overlay class="modal-overlay" />
          <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
            <Dialog.Content class="modal-surface w-full max-w-md p-6 flex flex-col gap-6">
              <div>
                <Dialog.Title class="text-xl font-semibold text-primary">Unable to launch OpenCode</Dialog.Title>
                <Dialog.Description class="text-sm text-secondary mt-2">
                  Install the OpenCode CLI and make sure it is available in your PATH, or pick a custom binary from
                  Advanced Settings.
                </Dialog.Description>
              </div>

              <div class="rounded-lg border border-base bg-surface-secondary p-4">
                <p class="text-xs font-medium text-muted uppercase tracking-wide mb-1">Binary path</p>
                <p class="text-sm font-mono text-primary break-all">{launchErrorPath()}</p>
              </div>

              <div class="flex justify-end gap-2">
                <button
                  type="button"
                  class="selector-button selector-button-secondary"
                  onClick={handleLaunchErrorAdvanced}
                >
                  Open Advanced Settings
                </button>
                <button type="button" class="selector-button selector-button-primary" onClick={handleLaunchErrorClose}>
                  Close
                </button>
              </div>
            </Dialog.Content>
          </div>
        </Dialog.Portal>
      </Dialog>
      <div class="h-screen w-screen flex flex-col">
        <Show
          when={!hasInstances()}
          fallback={
            <>
              <InstanceTabs
              instances={instances()}
              activeInstanceId={activeInstanceId()}
              onSelect={setActiveInstanceId}
              onClose={handleCloseInstance}
              onNew={handleNewInstanceRequest}
            />

            <Show when={activeInstance()} keyed>
              {(instance) => (
                <>
                  <Show when={activeSessions().size > 0} fallback={<InstanceWelcomeView instance={instance} />}>
                    <div class="flex flex-1 min-h-0">
                      {/* Session Sidebar */}
                      <div
                        class="session-sidebar flex flex-col bg-surface-secondary"
                        style={{ width: `${sessionSidebarWidth()}px` }}
                      >
                            <SessionList
                              instanceId={instance.id}
                              sessions={activeSessions()}
                              activeSessionId={activeSessionIdForInstance()}
                              onSelect={(id) => setActiveSession(instance.id, id)}
                              onClose={(id) => handleCloseSession(instance.id, id)}
                              onNew={() => handleNewSession(instance.id)}
                              showHeader
                              showFooter={false}
                              headerContent={
                                <div class="session-sidebar-header">
                                  <span class="session-sidebar-title text-sm font-semibold uppercase text-primary">Sessions</span>
                                  <div class="session-sidebar-shortcuts">
                                    {(() => {
                                      const shortcuts = [
                                        keyboardRegistry.get("session-prev"),
                                        keyboardRegistry.get("session-next"),
                                      ].filter((shortcut): shortcut is KeyboardShortcut => Boolean(shortcut))
                                      return shortcuts.length ? (
                                        <KeyboardHint shortcuts={shortcuts} separator=" " showDescription={false} />
                                      ) : null
                                    })()}
                                  </div>
                                </div>
                              }

                              onWidthChange={setSessionSidebarWidth}
                            />

                        <div class="session-sidebar-separator border-t border-base" />
                        <Show when={activeSessionForInstance()}>
                          {(activeSession) => (
                            <>
                              <ContextUsagePanel instanceId={instance.id} sessionId={activeSession().id} />
                              <div class="session-sidebar-controls px-3 py-3 border-r border-base flex flex-col gap-3">
                                <AgentSelector
                                  instanceId={instance.id}
                                  sessionId={activeSession().id}
                                  currentAgent={activeSession().agent}
                                  onAgentChange={handleSidebarAgentChange}
                                />

                                <ModelSelector
                                  instanceId={instance.id}
                                  sessionId={activeSession().id}
                                  currentModel={activeSession().model}
                                  onModelChange={handleSidebarModelChange}
                                />
                              </div>
                            </>
                          )}
                        </Show>
                      </div>
                      {/* Main Content Area */}
                      <div class="content-area flex-1 min-h-0 overflow-hidden flex flex-col">
                        <Show
                          when={activeSessionIdForInstance() === "info"}
                          fallback={
                            <Show
                              when={activeSessionIdForInstance()}
                              keyed
                              fallback={
                                <div class="flex items-center justify-center h-full">
                                  <div class="text-center text-gray-500 dark:text-gray-400">
                                    <p class="mb-2">No session selected</p>
                                    <p class="text-sm">Select a session to view messages</p>
                                  </div>
                                </div>
                              }
                            >
                              {(sessionId) => (
                                <SessionView
                                  sessionId={sessionId}
                                  activeSessions={activeSessions()}
                                  instanceId={instance.id}
                                  instanceFolder={instance.folder}
                                  escapeInDebounce={escapeInDebounce()}
                                />
                              )}
                            </Show>
                          }
                        >
                          <InfoView instanceId={instance.id} />
                        </Show>
                      </div>
                    </div>
                  </Show>
                </>
              )}
            </Show>
          </>
        }
      >
        <FolderSelectionView
          onSelectFolder={handleSelectFolder}
          isLoading={isSelectingFolder()}
          advancedSettingsOpen={isAdvancedSettingsOpen()}
          onAdvancedSettingsOpen={() => setIsAdvancedSettingsOpen(true)}
          onAdvancedSettingsClose={() => setIsAdvancedSettingsOpen(false)}
        />
      </Show>

      <CommandPalette
        open={isCommandPaletteOpen()}
        onClose={hideCommandPalette}
        commands={paletteCommands()}
        onExecute={handleExecuteCommand}
      />

      <Show when={showFolderSelection()}>
        <div class="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
          <div class="w-full h-full relative">
            <button
              onClick={() => {
                setShowFolderSelection(false)
                setIsAdvancedSettingsOpen(false)
                clearLaunchError()
              }}
              class="absolute top-4 right-4 z-10 p-2 bg-white dark:bg-gray-800 rounded-lg shadow-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              title="Close (Esc)"
            >
              <svg
                class="w-5 h-5 text-gray-600 dark:text-gray-300"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            <FolderSelectionView
              onSelectFolder={handleSelectFolder}
              isLoading={isSelectingFolder()}
              advancedSettingsOpen={isAdvancedSettingsOpen()}
              onAdvancedSettingsOpen={() => setIsAdvancedSettingsOpen(true)}
              onAdvancedSettingsClose={() => setIsAdvancedSettingsOpen(false)}
            />
          </div>
        </div>
      </Show>

      <Toaster
        position="top-right"
        gutter={16}
        toastOptions={{
          duration: 8000,
          className: "bg-transparent border-none shadow-none p-0",
        }}
      />
    </div>
    </>
  )
}

export default App
