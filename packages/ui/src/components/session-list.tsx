import { Component, For, Show, createSignal, createEffect, onCleanup, onMount, createMemo, JSX } from "solid-js"
import type { Session, SessionStatus } from "../types/session"
import { getSessionStatus } from "../stores/session-status"
import { MessageSquare, Info, Trash2, Copy } from "lucide-solid"
import KeyboardHint from "./keyboard-hint"
import Kbd from "./kbd"
import { keyboardRegistry } from "../lib/keyboard-registry"
import { formatShortcut } from "../lib/keyboard-utils"
import { showToastNotification } from "../lib/notifications"


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
  onWidthChange?: (width: number) => void
}

const MIN_WIDTH = 200
const MAX_WIDTH = 520
const DEFAULT_WIDTH = 360
const STORAGE_KEY = "opencode-session-sidebar-width-v7"

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
  const [sidebarWidth, setSidebarWidth] = createSignal(DEFAULT_WIDTH)
  const [isResizing, setIsResizing] = createSignal(false)
  const [startX, setStartX] = createSignal(0)
  const [startWidth, setStartWidth] = createSignal(DEFAULT_WIDTH)
  const [collapsedParents, setCollapsedParents] = createSignal<Set<string>>(new Set())
  const infoShortcut = keyboardRegistry.get("switch-to-info")
  const COLLAPSE_STORAGE_KEY = `opencode-collapsed-sessions-${props.instanceId}`

  const selectSession = (sessionId: string) => {
    props.onSelect(sessionId)
  }

  let mouseMoveHandler: ((event: MouseEvent) => void) | null = null
  let mouseUpHandler: (() => void) | null = null
  let touchMoveHandler: ((event: TouchEvent) => void) | null = null
  let touchEndHandler: (() => void) | null = null

  onMount(() => {
    if (typeof window === "undefined") return
    const saved = window.localStorage.getItem(STORAGE_KEY)
    if (!saved) return

    const width = Number.parseInt(saved, 10)
    if (Number.isFinite(width) && width >= MIN_WIDTH && width <= MAX_WIDTH) {
      setSidebarWidth(width)
      setStartWidth(width)
    }
  })

  createEffect(() => {
    if (typeof window === "undefined") return
    const width = sidebarWidth()
    window.localStorage.setItem(STORAGE_KEY, width.toString())
  })

  createEffect(() => {
    props.onWidthChange?.(sidebarWidth())
  })
 
  const copySessionId = async (event: MouseEvent, sessionId: string) => {
    event.stopPropagation()
 
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard) {
        throw new Error("Clipboard API unavailable")
      }
 
      await navigator.clipboard.writeText(sessionId)
      showToastNotification({ message: "Session ID copied", variant: "success" })
    } catch (error) {
      console.error(`Failed to copy session ID ${sessionId}:`, error)
      showToastNotification({ message: "Unable to copy session ID", variant: "error" })
    }
  }
 
  const clampWidth = (width: number) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width))
 

  const removeMouseListeners = () => {
    if (mouseMoveHandler) {
      document.removeEventListener("mousemove", mouseMoveHandler)
      mouseMoveHandler = null
    }
    if (mouseUpHandler) {
      document.removeEventListener("mouseup", mouseUpHandler)
      mouseUpHandler = null
    }
  }
 
  const removeTouchListeners = () => {
    if (touchMoveHandler) {
      document.removeEventListener("touchmove", touchMoveHandler)
      touchMoveHandler = null
    }
    if (touchEndHandler) {
      document.removeEventListener("touchend", touchEndHandler)
      touchEndHandler = null
    }
  }
 
  const stopResizing = () => {
    setIsResizing(false)
    removeMouseListeners()
    removeTouchListeners()
  }
 
  const handleMouseMove = (event: MouseEvent) => {
    if (!isResizing()) return
    const diff = event.clientX - startX()
    const newWidth = clampWidth(startWidth() + diff)
    setSidebarWidth(newWidth)
  }
 
  const handleMouseUp = () => {
    stopResizing()
  }
 
  const handleTouchMove = (event: TouchEvent) => {
    if (!isResizing()) return
    const touch = event.touches[0]
    if (!touch) return
    const diff = touch.clientX - startX()
    const newWidth = clampWidth(startWidth() + diff)
    setSidebarWidth(newWidth)
  }
 
  const handleTouchEnd = () => {
    stopResizing()
  }
 
  const handleMouseDown = (event: MouseEvent) => {
    event.preventDefault()
    setIsResizing(true)
    setStartX(event.clientX)
    setStartWidth(sidebarWidth())
 
    mouseMoveHandler = handleMouseMove
    mouseUpHandler = handleMouseUp
 
    document.addEventListener("mousemove", handleMouseMove)
    document.addEventListener("mouseup", handleMouseUp)
  }
 
  const handleTouchStart = (event: TouchEvent) => {
    event.preventDefault()
    const touch = event.touches[0]
    if (!touch) return
    setIsResizing(true)
    setStartX(touch.clientX)
    setStartWidth(sidebarWidth())
 
    touchMoveHandler = handleTouchMove
    touchEndHandler = handleTouchEnd
 
    document.addEventListener("touchmove", handleTouchMove)
    document.addEventListener("touchend", handleTouchEnd)
  }
 
  onCleanup(() => {
    removeMouseListeners()
    removeTouchListeners()
  })
 
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
                class="session-item-action opacity-80 hover:opacity-100 hover:bg-[var(--status-error)] hover:text-white rounded p-0.5 transition-all"
                onClick={(event) => {
                  event.stopPropagation()
                  props.onClose(rowProps.sessionId)
                }}
                role="button"
                tabIndex={0}
                aria-label="Delete session"
                title="Delete session"
              >
                <Trash2 class="w-3 h-3" />
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
            </div>
          </div>
        </button>
      </div>
    )
  }
 
  const sessionsByParent = createMemo(() => {
    const grouped = new Map<string, { parent: Session; children: Session[] }>()
    
    for (const session of props.sessions.values()) {
      if (session.parentId === null) {
        grouped.set(session.id, { parent: session, children: [] })
      }
    }
    
    for (const session of props.sessions.values()) {
      if (session.parentId !== null) {
        const group = grouped.get(session.parentId)
        if (group) {
          group.children.push(session)
        }
      }
    }
    
    for (const [_, group] of grouped) {
      group.children.sort((a, b) => (b.time.updated || 0) - (a.time.updated || 0))
    }
    
    return Array.from(grouped.values()).sort((a, b) => 
      (b.parent.time.updated || 0) - (a.parent.time.updated || 0)
    )
  })
 
  return (
    <div

      class="session-list-container bg-surface-secondary border-r border-base flex flex-col"
      style={{ width: `${sidebarWidth()}px` }}
    >
      <div
        class="session-resize-handle"
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        role="presentation"
        aria-hidden="true"
      />

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


        <Show when={sessionsByParent().length > 0}>
          <div class="session-section">
            <div class="session-section-header px-3 py-2 text-xs font-semibold text-primary/70 uppercase tracking-wide">
              Sessions ({props.sessions.size} total)
            </div>
            <For each={sessionsByParent()}>
              {({ parent, children }) => (
                <div class="session-group">
                  <SessionRow sessionId={parent.id} canClose />
                  <Show when={children.length > 0}>
                    <div class="ml-4 border-l border-base pl-3">
                      <For each={children}>
                        {(child) => <SessionRow sessionId={child.id} />}
                      </For>
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>

      <Show when={props.showFooter !== false}>
        <div class="session-list-footer p-3 border-t border-base">
          {props.footerContent ?? null}
        </div>
      </Show>
    </div>
  )
}

export default SessionList
