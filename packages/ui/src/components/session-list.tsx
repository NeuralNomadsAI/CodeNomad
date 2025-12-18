import { Component, For, Show, createSignal, createMemo, JSX } from "solid-js"
import type { Session, SessionStatus } from "../types/session"
import { getSessionStatus } from "../stores/session-status"
import { MessageSquare, X, Copy, Trash2, Pencil, MoreVertical, Plus, Info } from "lucide-solid"
import KeyboardHint from "./keyboard-hint"
import Kbd from "./kbd"
import SessionRenameDialog from "./session-rename-dialog"
import { keyboardRegistry } from "../lib/keyboard-registry"
import { formatShortcut } from "../lib/keyboard-utils"
import { showToastNotification } from "../lib/notifications"
import { deleteSession, loading, renameSession } from "../stores/sessions"
import { getLogger } from "../lib/logger"
import { DropdownMenu } from "@kobalte/core"
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
      if (typeof navigator === "undefined" || !navigator.clipboard) {
        throw new Error("Clipboard API unavailable")
      }
 
      await navigator.clipboard.writeText(sessionId)
      showToastNotification({ message: "Session ID copied", variant: "success" })
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
            </div>
            <Show when={rowProps.canClose}>
              <span
                class="session-item-close opacity-80 hover:opacity-100 hover:bg-status-error hover:text-white rounded p-0.5 transition-all"
                onClick={(event) => {
                  event.stopPropagation()
                  props.onClose(rowProps.sessionId)
                }}
                role="button"
                tabIndex={0}
                aria-label="Close session"
              >
                <X class="w-3 h-3" />
              </span>
            </Show>
          </div>
          <div class="session-item-row session-item-meta">
            <span class={`status-indicator session-status session-status-list ${statusClassName()}`}>
              <span class="status-dot" />
              {statusText()}
            </span>
            <div class="session-item-actions">
              <span
                class={`session-item-close opacity-80 hover:opacity-100 ${isActive() ? "hover:bg-white/20" : "hover:bg-surface-hover"}`}
                onClick={(event) => copySessionId(event, rowProps.sessionId)}
                role="button"
                tabIndex={0}
                aria-label="Copy session ID"
                title="Copy session ID"
              >
                <Copy class="w-3 h-3" />
              </span>
              <span
                class={`session-item-close opacity-80 hover:opacity-100 ${isActive() ? "hover:bg-white/20" : "hover:bg-surface-hover"}`}
                onClick={(event) => {
                  event.stopPropagation()
                  openRenameDialog(rowProps.sessionId)
                }}
                role="button"
                tabIndex={0}
                aria-label="Rename session"
                title="Rename session"
              >
                <Pencil class="w-3 h-3" />
              </span>
              <span
                class={`session-item-close opacity-80 hover:opacity-100 ${isActive() ? "hover:bg-white/20" : "hover:bg-surface-hover"}`}
                onClick={(event) => handleDeleteSession(event, rowProps.sessionId)}
                role="button"
                tabIndex={0}
                aria-label="Delete session"
                title="Delete session"
              >
                <Show
                  when={!isSessionDeleting(rowProps.sessionId)}
                  fallback={
                    <svg class="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                      <path
                        class="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      />
                    </svg>
                  }
                >
                  <Trash2 class="w-3 h-3" />
                </Show>
              </span>
            </div>
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
 
  return (
    <div
      class="session-list-container bg-surface-secondary border-r border-base flex flex-col w-full"
    >
      <Show when={props.showHeader !== false}>
        <div class="session-list-header p-3 border-b border-base">
          {props.headerContent ?? (
            <div class="flex items-center justify-between gap-3">
              <h3 class="text-sm font-semibold text-primary">Sessions</h3>
              <KeyboardHint
                shortcuts={[keyboardRegistry.get("session-prev")!, keyboardRegistry.get("session-next")!].filter(Boolean)}
              />
            </div>
          )}
        </div>
      </Show>

      <div class="session-list flex-1 overflow-y-auto">
          <div class="session-section">
            <div class="session-section-header px-3 py-2 text-xs font-semibold text-primary/70 uppercase tracking-wide">
              Instance
            </div>
            <div class="session-list-item group">
              <button
                class={`session-item-base ${props.activeSessionId === "info" ? "session-item-active" : "session-item-inactive"}`}
                onClick={() => selectSession("info")}
                title="Instance Info"
                role="button"
                aria-selected={props.activeSessionId === "info"}
              >
                <div class="session-item-row session-item-header">
                  <div class="session-item-title-row">
                    <Info class="w-4 h-4 flex-shrink-0" />
                    <span class="session-item-title truncate">Instance Info</span>
                  </div>
                  {infoShortcut && <Kbd shortcut={formatShortcut(infoShortcut)} class="ml-2 not-italic" />}
                </div>
              </button>
            </div>
          </div>


        <Show when={userSessionIds().length > 0}>
          <div class="session-section">
            <div class="session-section-header px-3 py-2 text-xs font-semibold text-primary/70 uppercase tracking-wide">
              User Session
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

