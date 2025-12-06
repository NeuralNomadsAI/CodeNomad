import { Show, createMemo, createSignal, onCleanup, onMount, type Component } from "solid-js"
import type { Accessor } from "solid-js"
import type { Instance } from "../../types/instance"
import type { Command } from "../../lib/commands"
import { activeParentSessionId, activeSessionId as activeSessionMap, getSessionFamily, setActiveSession } from "../../stores/sessions"
import { keyboardRegistry, type KeyboardShortcut } from "../../lib/keyboard-registry"
import { buildCustomCommandEntries } from "../../lib/command-utils"
import { getCommands as getInstanceCommands } from "../../stores/commands"
import { isOpen as isCommandPaletteOpen, hideCommandPalette } from "../../stores/command-palette"
import SessionList from "../session-list"
import KeyboardHint from "../keyboard-hint"
import InstanceWelcomeView from "../instance-welcome-view"
import InfoView from "../info-view"
import AgentSelector from "../agent-selector"
import ModelSelector from "../model-selector"
import CommandPalette from "../command-palette"
import Kbd from "../kbd"
import ContextUsagePanel from "../session/context-usage-panel"
import SessionView from "../session/session-view"
import { getLogger } from "../../lib/logger"
const log = getLogger("session")


interface InstanceShellProps {
  instance: Instance
  escapeInDebounce: boolean
  paletteCommands: Accessor<Command[]>
  onCloseSession: (sessionId: string) => Promise<void> | void
  onNewSession: () => Promise<void> | void
  handleSidebarAgentChange: (sessionId: string, agent: string) => Promise<void>
  handleSidebarModelChange: (sessionId: string, model: { providerId: string; modelId: string }) => Promise<void>
  onExecuteCommand: (command: Command) => void
}

const DEFAULT_SESSION_SIDEBAR_WIDTH = 350
const MOBILE_SIDEBAR_BREAKPOINT = 1024

const InstanceShell: Component<InstanceShellProps> = (props) => {
  const [sessionSidebarWidth, setSessionSidebarWidth] = createSignal(DEFAULT_SESSION_SIDEBAR_WIDTH)
  const [isCompactLayout, setIsCompactLayout] = createSignal(false)
  const [isSidebarOpen, setIsSidebarOpen] = createSignal(true)
  const sidebarId = `session-sidebar-${props.instance.id}`
  let previousIsCompact = false

  const shouldShowSidebarToggle = () => isCompactLayout() && !isSidebarOpen()

  onMount(() => {
    if (typeof window === "undefined") return

    const handleResize = () => {
      const compact = window.innerWidth < MOBILE_SIDEBAR_BREAKPOINT
      setIsCompactLayout(compact)
      if (!compact) {
        setIsSidebarOpen(true)
      } else if (!previousIsCompact && compact) {
        setIsSidebarOpen(false)
      }
      previousIsCompact = compact
    }

    handleResize()
    window.addEventListener("resize", handleResize)

    onCleanup(() => {
      window.removeEventListener("resize", handleResize)
    })
  })

  const activeSessions = createMemo(() => {
    const parentId = activeParentSessionId().get(props.instance.id)
    if (!parentId) return new Map<string, ReturnType<typeof getSessionFamily>[number]>()
    const sessionFamily = getSessionFamily(props.instance.id, parentId)
    return new Map(sessionFamily.map((s) => [s.id, s]))
  })

  const activeSessionIdForInstance = createMemo(() => {
    return activeSessionMap().get(props.instance.id) || null
  })

  const activeSessionForInstance = createMemo(() => {
    const sessionId = activeSessionIdForInstance()
    if (!sessionId || sessionId === "info") return null
    return activeSessions().get(sessionId) ?? null
  })

  const customCommands = createMemo(() => buildCustomCommandEntries(props.instance.id, getInstanceCommands(props.instance.id)))
  const instancePaletteCommands = createMemo(() => [...props.paletteCommands(), ...customCommands()])
  const paletteOpen = createMemo(() => isCommandPaletteOpen(props.instance.id))

  const keyboardShortcuts = createMemo(() =>
    [keyboardRegistry.get("session-prev"), keyboardRegistry.get("session-next")].filter(
      (shortcut): shortcut is KeyboardShortcut => Boolean(shortcut),
    ),
  )

  const handleSessionSelect = (sessionId: string) => {
    setActiveSession(props.instance.id, sessionId)
  }

  return (
    <>
      <Show when={activeSessions().size > 0} fallback={<InstanceWelcomeView instance={props.instance} />}>
        <div
          class="flex flex-1 min-h-0 relative"
          classList={{ "session-layout-compact": isCompactLayout() }}
        >
          <div
            id={sidebarId}
            class="session-sidebar flex flex-col bg-surface-secondary"
            classList={{
              "session-sidebar-overlay": isCompactLayout(),
              "session-sidebar-collapsed": isCompactLayout() && !isSidebarOpen(),
            }}
            style={!isCompactLayout() ? { width: `${sessionSidebarWidth()}px` } : undefined}
            aria-hidden={isCompactLayout() && !isSidebarOpen()}
          >
            <SessionList
              instanceId={props.instance.id}
              sessions={activeSessions()}
              activeSessionId={activeSessionIdForInstance()}
              onSelect={handleSessionSelect}
              onClose={(id) => {
                const result = props.onCloseSession(id)
                if (result instanceof Promise) {
                  void result.catch((error) => log.error("Failed to close session:", error))
                }
              }}
              onNew={() => {
                const result = props.onNewSession()
                if (result instanceof Promise) {
                  void result.catch((error) => log.error("Failed to create session:", error))
                }
              }}
              showHeader
              showFooter={false}
              headerContent={
                <div class="session-sidebar-header">
                  <div class="session-sidebar-header-row">
                    <span class="session-sidebar-title text-sm font-semibold uppercase text-primary">Sessions</span>
                    <Show when={isCompactLayout()}>
                      <button
                        type="button"
                        class="session-sidebar-close"
                        onClick={() => setIsSidebarOpen(false)}
                        aria-label="Close session sidebar"
                      >
                        Close
                      </button>
                    </Show>
                  </div>
                  <div class="session-sidebar-shortcuts">
                    {keyboardShortcuts().length ? (
                      <KeyboardHint shortcuts={keyboardShortcuts()} separator=" " showDescription={false} />
                    ) : null}
                  </div>
                </div>
              }
              onWidthChange={setSessionSidebarWidth}
            />

            <div class="session-sidebar-separator border-t border-base" />
            <Show when={activeSessionForInstance()}>
              {(activeSession) => (
                <>
                  <ContextUsagePanel instanceId={props.instance.id} sessionId={activeSession().id} />
                  <div class="session-sidebar-controls px-3 py-3 border-r border-base flex flex-col gap-3">
                    <AgentSelector
                      instanceId={props.instance.id}
                      sessionId={activeSession().id}
                      currentAgent={activeSession().agent}
                      onAgentChange={(agent) => props.handleSidebarAgentChange(activeSession().id, agent)}
                    />

                    <div class="sidebar-selector-hints" aria-hidden="true">
                      <span class="hint sidebar-selector-hint sidebar-selector-hint--left">
                        <Kbd shortcut="cmd+shift+a" />
                      </span>
                      <span class="hint sidebar-selector-hint sidebar-selector-hint--right">
                        <Kbd shortcut="cmd+shift+m" />
                      </span>
                    </div>

                    <ModelSelector
                      instanceId={props.instance.id}
                      sessionId={activeSession().id}
                      currentModel={activeSession().model}
                      onModelChange={(model) => props.handleSidebarModelChange(activeSession().id, model)}
                    />

                  </div>
                </>
              )}
            </Show>
          </div>

          <div class="content-area flex-1 min-h-0 overflow-hidden flex flex-col">
            <Show
              when={shouldShowSidebarToggle() && (!activeSessionIdForInstance() || activeSessionIdForInstance() === "info")}
            >
              <button
                type="button"
                class="session-sidebar-menu-button session-sidebar-menu-button--floating"
                onClick={() => setIsSidebarOpen(true)}
                aria-controls={sidebarId}
                aria-expanded={isSidebarOpen()}
                aria-label="Open session list"
              >
                <span aria-hidden="true" class="session-sidebar-menu-icon">☰</span>
              </button>
            </Show>
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
                      instanceId={props.instance.id}
                      instanceFolder={props.instance.folder}
                      escapeInDebounce={props.escapeInDebounce}
                      showSidebarToggle={shouldShowSidebarToggle()}
                      onSidebarToggle={() => setIsSidebarOpen(true)}
                    />
                  )}
                </Show>
              }
            >
              <InfoView instanceId={props.instance.id} />
            </Show>
          </div>

          <Show when={isCompactLayout() && isSidebarOpen()}>
            <button
              type="button"
              class="session-sidebar-backdrop"
              aria-label="Close session sidebar"
              onClick={() => setIsSidebarOpen(false)}
            />
          </Show>
        </div>
      </Show>

      <CommandPalette
        open={paletteOpen()}
        onClose={() => hideCommandPalette(props.instance.id)}
        commands={instancePaletteCommands()}
        onExecute={props.onExecuteCommand}
      />
    </>
  )
}

export default InstanceShell
