import { Component, For, Show, createSignal, createMemo, JSX } from "solid-js"
import type { Session, SessionStatus } from "../types/session"
import { getSessionStatus } from "../stores/session-status"
import { MessageSquare, X, Copy, Trash2, Pencil, MoreVertical, Plus, Pin, PinOff } from "lucide-solid"
import Kbd from "./kbd"
import SessionRenameDialog from "./session-rename-dialog"
import { keyboardRegistry } from "../lib/keyboard-registry"
import { formatShortcut } from "../lib/keyboard-utils"
import { showToastNotification } from "../lib/notifications"
import { deleteSession, loading, renameSession, getSessionInfo } from "../stores/sessions"
import { formatTokenTotal } from "../lib/formatters"
import { getLogger } from "../lib/logger"
import { DropdownMenu } from "@kobalte/core"
import { copyToClipboard } from "../lib/clipboard"
import { cn } from "../lib/cn"
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
       <div class="border-b last:border-b-0 border-border min-w-0 max-w-full group">

        <button
          class={cn(
            "w-full flex flex-col gap-1 px-3 py-2.5 text-left transition-colors outline-none font-sans text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
            isActive()
              ? "bg-accent text-foreground font-medium shadow-[inset_0_0_0_1px_hsl(var(--border))]"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
          onClick={() => selectSession(rowProps.sessionId)}
          title={title()}
          role="button"
          aria-selected={isActive()}
        >
          <div class="flex items-center gap-2 w-full justify-between">
            <div class="flex items-center gap-2 min-w-0 flex-1">
              <MessageSquare class="w-4 h-4 flex-shrink-0" />
              <span class="flex-1 min-w-0 truncate">{title()}</span>
              <span class={cn(
                "text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full flex-shrink-0",
                isParent() ? "bg-info text-primary-foreground" : "bg-muted text-muted-foreground border border-border",
              )}>
                {isParent() ? "Parent" : "Agent"}
              </span>
            </div>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger
                class="flex-shrink-0 text-muted-foreground hover:text-foreground hover:bg-accent opacity-80 hover:opacity-100 rounded p-0.5 transition-all"
                onClick={(e: MouseEvent) => e.stopPropagation()}
              >
                <MoreVertical class="w-3.5 h-3.5" />
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content class="rounded-lg shadow-lg py-1 min-w-[140px] z-50 bg-background border border-border animate-in fade-in-0 zoom-in-95">
                  <DropdownMenu.Item
                    class="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer outline-none transition-colors text-foreground hover:bg-accent focus:bg-accent"
                    onSelect={() => copySessionId(new MouseEvent("click"), rowProps.sessionId)}
                  >
                    <Copy class="w-3.5 h-3.5" />
                    <span>Copy ID</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    class="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer outline-none transition-colors text-foreground hover:bg-accent focus:bg-accent"
                    onSelect={() => openRenameDialog(rowProps.sessionId)}
                  >
                    <Pencil class="w-3.5 h-3.5" />
                    <span>Rename</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    class="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer outline-none transition-colors text-destructive hover:bg-destructive/10 focus:bg-destructive/10"
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
          <div class="flex items-center gap-2 w-full justify-between items-center text-xs text-muted-foreground mt-0.5">
            <div class="mt-1 flex items-center gap-1.5">
              <div class="relative flex-1 max-w-[100px] h-[3px] rounded-full overflow-hidden bg-white/10">
                <div
                  class={`absolute top-0 left-0 h-full rounded-full ${
                    contextLevel() === "critical" ? "bg-destructive" :
                    contextLevel() === "warning" ? "bg-warning" :
                    "bg-success"
                  }`}
                  style={{ width: `${contextPercentage()}%` }}
                />
              </div>
              <span class="text-[9px] font-mono text-muted-foreground whitespace-nowrap">
                {formatTokenTotal(contextUsed())}/{contextTotal() !== null ? formatTokenTotal(contextTotal()!) : "--"}
              </span>
            </div>
            <span class={cn(
              "text-[0.65rem] uppercase tracking-wide font-medium inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-transparent",
              statusClassName() === "session-working" && "text-warning font-medium",
              statusClassName() === "session-compacting" && "text-info font-medium",
              statusClassName() === "session-idle" && "text-success font-medium",
              statusClassName() === "session-permission" && "text-warning",
            )}>
              <span class={cn(
                "w-2 h-2 rounded-full",
                statusClassName() === "session-working" && "bg-warning animate-pulse",
                statusClassName() === "session-compacting" && "bg-info animate-pulse",
                statusClassName() === "session-idle" && "bg-success",
                statusClassName() === "session-permission" && "bg-warning",
              )} />
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
 
  return (
    <div
      class="flex flex-col flex-1 min-h-0 relative bg-secondary min-w-[200px] max-w-[500px] border-r border-border flex flex-col w-full"
    >
      <Show when={props.showHeader !== false}>
        <div class="border-b border-border relative p-3">
          {props.headerContent ?? null}
        </div>
      </Show>

      <div class="flex-1 overflow-y-auto">
        {/* Pin button header */}
        <Show when={!props.isPhoneLayout && props.onTogglePin}>
          <div class="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider justify-end border-b border-border">
            <button
              type="button"
              class="inline-flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              aria-label={props.leftPinned ? "Unpin drawer" : "Pin drawer"}
              onClick={props.onTogglePin}
            >
              {props.leftPinned ? <Pin class="w-3.5 h-3.5" /> : <PinOff class="w-3.5 h-3.5" />}
            </button>
          </div>
        </Show>

        <Show when={userSessionIds().length > 0}>
          <div class="pb-1">
            <div class="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              Agents
            </div>
            <For each={userSessionIds()}>{(id) => <SessionRow sessionId={id} canClose />}</For>
          </div>
        </Show>

        <Show when={childSessionIds().length > 0}>
          <div class="pt-1">
            <Show when={userSessionIds().length > 0}>
              <div class="mx-3 mb-1 border-t border-border" />
            </Show>
            <div class="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              Agent Sessions
            </div>
            <For each={childSessionIds()}>{(id) => <SessionRow sessionId={id} />}</For>
          </div>
        </Show>
      </div>

      <Show when={props.showFooter !== false}>
        <div class="border-t border-border p-3">
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

