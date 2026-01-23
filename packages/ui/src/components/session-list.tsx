import { Component, For, Show, createSignal, createMemo, JSX } from "solid-js"
import type { Session, SessionStatus } from "../types/session"
import { getSessionStatus } from "../stores/session-status"
import { MessageSquare, X, Copy, Trash2, Pencil, MoreVertical, Plus, Info, Pin, PinOff } from "lucide-solid"
import Kbd from "./kbd"
import SessionRenameDialog from "./session-rename-dialog"
import { keyboardRegistry } from "../lib/keyboard-registry"
import { formatShortcut } from "../lib/keyboard-utils"
import { showToastNotification } from "../lib/notifications"
import { deleteSession, loading, renameSession, getSessionInfo } from "../stores/sessions"
import { formatTokenTotal } from "../lib/formatters"
import { getLogger } from "../lib/logger"
import { DropdownMenu } from "@kobalte/core"
import { getActiveInstance } from "../stores/instances"
import { copyToClipboard } from "../lib/clipboard"
const log = getLogger("session")



interface SessionListProps {
  instanceId: string
  sessions: Map<string, Session>
  activeSessionId: string | null
  onSelect: (sessionId: string) => void
  onClose: (sessionId: string) => void
  onNew: () => void
  showHeader?: boolean
  showFooter?: boolean
  headerContent?: JSX.Element
  footerContent?: JSX.Element
  leftPinned?: boolean
  onTogglePin?: () => void
  isPhoneLayout?: boolean
}

function formatSessionStatus(status: SessionStatus): string {
  switch (status) {
    case "working":
      return "Working"
    case "compacting":
      return "Compacting"
    default:
      return "Idle"
  }
}

function arraysEqual(prev: readonly string[] | undefined, next: readonly string[]): boolean {
  if (!prev) {
    return false
  }

  if (prev.length !== next.length) {
    return false
  }

  for (let i = 0; i < prev.length; i++) {
    if (prev[i] !== next[i]) {
      return false
    }
  }

  return true
}

const SessionList: Component<SessionListProps> = (props) => {
  const [renameTarget, setRenameTarget] = createSignal<{ id: string; title: string; label: string } | null>(null)
  const [isRenaming, setIsRenaming] = createSignal(false)
  const infoShortcut = keyboardRegistry.get("switch-to-info")
 
  const isSessionDeleting = (sessionId: string) => {
    const deleting = loading().deletingSession.get(props.instanceId)
    return deleting ? deleting.has(sessionId) : false
  }
 
  const selectSession = (sessionId: string) => {
    props.onSelect(sessionId)
  }
 
  const copySessionId = async (event: MouseEvent, sessionId: string) => {
    event.stopPropagation()

    try {
      const success = await copyToClipboard(sessionId)
      if (success) {
        showToastNotification({ message: "Session ID copied", variant: "success" })
      } else {
        showToastNotification({ message: "Unable to copy session ID", variant: "error" })
      }
    } catch (error) {
      log.error(`Failed to copy session ID ${sessionId}:`, error)
      showToastNotification({ message: "Unable to copy session ID", variant: "error" })
    }
  }
 
  const handleDeleteSession = async (event: MouseEvent, sessionId: string) => {
    event.stopPropagation()
    if (isSessionDeleting(sessionId)) return
 
    try {
      await deleteSession(props.instanceId, sessionId)
    } catch (error) {
      log.error(`Failed to delete session ${sessionId}:`, error)
      showToastNotification({ message: "Unable to delete session", variant: "error" })
    }
  }

  const openRenameDialog = (sessionId: string) => {
    const session = props.sessions.get(sessionId)
    if (!session) return
    const label = session.title && session.title.trim() ? session.title : sessionId
    setRenameTarget({ id: sessionId, title: session.title ?? "", label })
  }

  const closeRenameDialog = () => {
    setRenameTarget(null)
  }

  const handleRenameSubmit = async (nextTitle: string) => {
    const target = renameTarget()
    if (!target) return
 
    setIsRenaming(true)
    try {
      await renameSession(props.instanceId, target.id, nextTitle)
      setRenameTarget(null)
    } catch (error) {
      log.error(`Failed to rename session ${target.id}:`, error)
      showToastNotification({ message: "Unable to rename session", variant: "error" })
    } finally {
      setIsRenaming(false)
    }
  }
 

  const SessionRow: Component<{ sessionId: string; canClose?: boolean }> = (rowProps) => {
    const session = () => props.sessions.get(rowProps.sessionId)
    if (!session()) {
      return <></>
    }
    const isActive = () => props.activeSessionId === rowProps.sessionId
    const title = () => session()?.title || "Untitled"
    const status = () => getSessionStatus(props.instanceId, rowProps.sessionId)
    const statusLabel = () => formatSessionStatus(status())
    const pendingPermission = () => Boolean(session()?.pendingPermission)
    const statusClassName = () => (pendingPermission() ? "session-permission" : `session-${status()}`)
    const statusText = () => (pendingPermission() ? "Needs Permission" : statusLabel())
    const isParent = () => session()?.parentId === null

    const sessionInfo = createMemo(() => getSessionInfo(props.instanceId, rowProps.sessionId))
    const contextUsed = () => sessionInfo()?.actualUsageTokens ?? 0
    const contextAvail = () => sessionInfo()?.contextAvailableTokens ?? null
    const contextTotal = () => {
      const avail = contextAvail()
      if (avail === null) return null
      return contextUsed() + avail
    }
    const contextPercentage = () => {
      const total = contextTotal()
      if (total === null || total === 0) return 0
      return Math.min((contextUsed() / total) * 100, 100)
    }
    const contextLevel = () => {
      const pct = contextPercentage()
      if (pct >= 90) return "critical"
      if (pct >= 75) return "warning"
      return "normal"
    }

    return (
       <div class="session-list-item group">

        <button
          class={`session-item-base ${isActive() ? "session-item-active" : "session-item-inactive"}`}
          onClick={() => selectSession(rowProps.sessionId)}
          title={title()}
          role="button"
          aria-selected={isActive()}
        >
          <div class="session-item-row session-item-header">
            <div class="session-item-title-row">
              <MessageSquare class="w-4 h-4 flex-shrink-0" />
              <span class="session-item-title truncate">{title()}</span>
              <span class={`session-type-pill ${isParent() ? "session-type-pill--parent" : "session-type-pill--agent"}`}>
                {isParent() ? "Parent" : "Agent"}
              </span>
            </div>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger
                class="session-item-menu-trigger opacity-80 hover:opacity-100 rounded p-0.5 transition-all"
                onClick={(e: MouseEvent) => e.stopPropagation()}
              >
                <MoreVertical class="w-3.5 h-3.5" />
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content class="session-dropdown-menu">
                  <DropdownMenu.Item
                    class="session-dropdown-item"
                    onSelect={() => copySessionId(new MouseEvent("click"), rowProps.sessionId)}
                  >
                    <Copy class="w-3.5 h-3.5" />
                    <span>Copy ID</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    class="session-dropdown-item"
                    onSelect={() => openRenameDialog(rowProps.sessionId)}
                  >
                    <Pencil class="w-3.5 h-3.5" />
                    <span>Rename</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    class="session-dropdown-item session-dropdown-item--danger"
                    onSelect={() => handleDeleteSession(new MouseEvent("click"), rowProps.sessionId)}
                    title="Delete conversation history. The OpenCode process continues running."
                  >
                    <Show
                      when={!isSessionDeleting(rowProps.sessionId)}
                      fallback={
                        <svg class="animate-spin h-3.5 w-3.5" fill="none" viewBox="0 0 24 24">
                          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                          <path
                            class="opacity-75"
                            fill="currentColor"
                            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                          />
                        </svg>
                      }
                    >
                      <Trash2 class="w-3.5 h-3.5" />
                    </Show>
                    <span>Delete Session</span>
                  </DropdownMenu.Item>
                  {/* Removed "Close Session" action - it was confusing because it didn't stop the process */}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
          <div class="session-item-row session-item-meta">
            <div class="session-item-progress">
              <div class="context-progress-track">
                <div
                  class={`context-progress-fill context-progress-fill--${contextLevel()}`}
                  style={{ width: `${contextPercentage()}%` }}
                />
              </div>
              <span class="session-progress-label">
                {formatTokenTotal(contextUsed())}/{contextTotal() !== null ? formatTokenTotal(contextTotal()!) : "--"}
              </span>
            </div>
            <span class={`status-indicator session-status session-status-list ${statusClassName()}`}>
              <span class="status-dot" />
              {statusText()}
            </span>
          </div>
        </button>
      </div>
    )
  }
 
  const userSessionIds = createMemo(
    () => {
      const ids: string[] = []
      for (const session of props.sessions.values()) {
        if (session.parentId === null) {
          ids.push(session.id)
        }
      }
      return ids
    },
    undefined,
    { equals: arraysEqual },
  )
 
  const childSessionIds = createMemo(
    () => {
      const children: { id: string; updated: number }[] = []
      for (const session of props.sessions.values()) {
        if (session.parentId !== null) {
          children.push({ id: session.id, updated: session.time.updated ?? 0 })
        }
      }
      if (children.length <= 1) {
        return children.map((entry) => entry.id)
      }
      children.sort((a, b) => b.updated - a.updated)
      return children.map((entry) => entry.id)
    },
    undefined,
    { equals: arraysEqual },
  )
 
  const instance = () => getActiveInstance()
  const parentSession = createMemo(() => {
    for (const session of props.sessions.values()) {
      if (session.parentId === null && session.title && session.title.trim()) {
        return session.title
      }
    }
    return null
  })

  return (
    <div
      class="session-list-container bg-surface-secondary border-r border-base flex flex-col w-full"
    >
      <Show when={props.showHeader !== false}>
        <div class="session-list-header p-3 border-b border-base">
          {props.headerContent ?? null}
        </div>
      </Show>

      <div class="session-list flex-1 overflow-y-auto">
          <div class="session-section">
            <div class="session-section-header px-3 py-2 text-xs font-semibold text-primary/70 uppercase tracking-wide flex items-center justify-between">
              <span>Instance</span>
              <Show when={!props.isPhoneLayout && props.onTogglePin}>
                <button
                  type="button"
                  class="icon-button icon-button--sm icon-button--ghost"
                  aria-label={props.leftPinned ? "Unpin drawer" : "Pin drawer"}
                  onClick={props.onTogglePin}
                >
                  {props.leftPinned ? <Pin class="w-3.5 h-3.5" /> : <PinOff class="w-3.5 h-3.5" />}
                </button>
              </Show>
            </div>
            <button
              class={`instance-info-panel instance-info-panel--clickable px-3 py-2 w-full text-left ${props.activeSessionId === "info" ? "instance-info-panel--active" : ""}`}
              onClick={() => selectSession("info")}
              title="OpenCode process running. Close the instance tab to stop it and free resources."
              type="button"
            >
              <div class="instance-info-grid">
                <Show when={instance()}>
                  <div class="instance-info-row">
                    <span class="instance-info-label">Port</span>
                    <span class="instance-info-value">{instance()?.port ?? "—"}</span>
                  </div>
                  <div class="instance-info-row">
                    <span class="instance-info-label">PID</span>
                    <span class="instance-info-value">{instance()?.pid ?? "—"}</span>
                  </div>
                  <div class="instance-info-row">
                    <span class="instance-info-label">Process</span>
                    <span class="instance-info-value instance-info-status">
                      <span class="status-dot status-dot--connected" />
                      Running
                    </span>
                  </div>
                </Show>
              </div>
              <div class="session-name-section">
                <span class="session-name-label">Session</span>
                <span class="session-name-value">
                  {parentSession() ?? "—"}
                </span>
              </div>
            </button>
          </div>


        <Show when={userSessionIds().length > 0}>
          <div class="session-section">
            <div class="session-section-header px-3 py-2 text-xs font-semibold text-primary/70 uppercase tracking-wide">
              Agents
            </div>
            <For each={userSessionIds()}>{(id) => <SessionRow sessionId={id} canClose />}</For>
          </div>
        </Show>

        <Show when={childSessionIds().length > 0}>
          <div class="session-section">
            <div class="session-section-header px-3 py-2 text-xs font-semibold text-primary/70 uppercase tracking-wide">
              Agent Sessions
            </div>
            <For each={childSessionIds()}>{(id) => <SessionRow sessionId={id} />}</For>
          </div>
        </Show>
      </div>

      <Show when={props.showFooter !== false}>
        <div class="session-list-footer p-3 border-t border-base">
          {props.footerContent ?? null}
        </div>
      </Show>

      <SessionRenameDialog
        open={Boolean(renameTarget())}
        currentTitle={renameTarget()?.title ?? ""}
        sessionLabel={renameTarget()?.label}
        isSubmitting={isRenaming()}
        onRename={handleRenameSubmit}
        onClose={closeRenameDialog}
      />
    </div>
  )
}

export default SessionList

