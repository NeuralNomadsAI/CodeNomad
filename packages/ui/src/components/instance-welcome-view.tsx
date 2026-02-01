import { Component, createSignal, Show, For, createEffect, onMount, onCleanup, createMemo } from "solid-js"
import { Loader2, Pencil, Trash2 } from "lucide-solid"

import type { Instance } from "../types/instance"
import { getParentSessions, createSession, setActiveParentSession, deleteSession, loading, renameSession } from "../stores/sessions"
import InstanceInfo from "./instance-info"
import Kbd from "./kbd"
import SessionRenameDialog from "./session-rename-dialog"
import { keyboardRegistry, type KeyboardShortcut } from "../lib/keyboard-registry"
import { isMac } from "../lib/keyboard-utils"
import { showToastNotification } from "../lib/notifications"
import { getLogger } from "../lib/logger"
import { cn } from "../lib/cn"
const log = getLogger("actions")



interface InstanceWelcomeViewProps {
  instance: Instance
}

const InstanceWelcomeView: Component<InstanceWelcomeViewProps> = (props) => {
  const [isCreating, setIsCreating] = createSignal(false)
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [focusMode, setFocusMode] = createSignal<"sessions" | "new-session" | null>("sessions")
  const [showInstanceInfoOverlay, setShowInstanceInfoOverlay] = createSignal(false)
  const [isDesktopLayout, setIsDesktopLayout] = createSignal(
    typeof window !== "undefined" ? window.matchMedia("(min-width: 1024px)").matches : false,
  )
  const [renameTarget, setRenameTarget] = createSignal<{ id: string; title: string; label: string } | null>(null)
  const [isRenaming, setIsRenaming] = createSignal(false)

  const parentSessions = () => getParentSessions(props.instance.id)
  const isFetchingSessions = createMemo(() => Boolean(loading().fetchingSessions.get(props.instance.id)))
  const isSessionDeleting = (sessionId: string) => {
    const deleting = loading().deletingSession.get(props.instance.id)
    return deleting ? deleting.has(sessionId) : false
  }
  const newSessionShortcut = createMemo<KeyboardShortcut>(() => {
    const registered = keyboardRegistry.get("session-new")
    if (registered) return registered
    return {
      id: "session-new-display",
      key: "n",
      modifiers: {
        shift: true,
        meta: isMac(),
        ctrl: !isMac(),
      },
      handler: () => {},
      description: "New Session",
      context: "global",
    }
  })
  const newSessionShortcutString = createMemo(() => (isMac() ? "cmd+shift+n" : "ctrl+shift+n"))

  createEffect(() => {
    const sessions = parentSessions()
    if (sessions.length === 0) {
      setFocusMode("new-session")
      setSelectedIndex(0)
    } else {
      setFocusMode("sessions")
      setSelectedIndex(0)
    }
  })

  const openInstanceInfoOverlay = () => {
    if (isDesktopLayout()) return
    setShowInstanceInfoOverlay(true)
  }
  const closeInstanceInfoOverlay = () => setShowInstanceInfoOverlay(false)

  function scrollToIndex(index: number) {
    const element = document.querySelector(`[data-session-index="${index}"]`)
    if (element) {
      element.scrollIntoView({ block: "nearest", behavior: "auto" })
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    let activeElement: HTMLElement | null = null
    if (typeof document !== "undefined") {
      activeElement = document.activeElement as HTMLElement | null
    }
    const insideModal = activeElement?.closest("[data-modal-surface]") || activeElement?.closest("[role='dialog']")
    const isEditingField =
      activeElement &&
      (["INPUT", "TEXTAREA", "SELECT"].includes(activeElement.tagName) ||
        activeElement.isContentEditable ||
        Boolean(insideModal))
 
    if (isEditingField) {
      if (insideModal && e.key === "Escape" && renameTarget()) {
        e.preventDefault()
        closeRenameDialog()
      }
      return
    }
 
    if (showInstanceInfoOverlay()) {
      if (e.key === "Escape") {
        e.preventDefault()
        closeInstanceInfoOverlay()
      }
      return
    }
 
    const sessions = parentSessions()
 
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "n") {
      e.preventDefault()
      handleNewSession()
      return
    }
 
    if (sessions.length === 0) return
 
    const listFocused = focusMode() === "sessions"
 
    if (e.key === "ArrowDown") {
      if (!listFocused) {
        setFocusMode("sessions")
        setSelectedIndex(0)
      }
      e.preventDefault()
      const newIndex = Math.min(selectedIndex() + 1, sessions.length - 1)
      setSelectedIndex(newIndex)
      scrollToIndex(newIndex)
      return
    }
 
    if (e.key === "ArrowUp") {
      if (!listFocused) {
        setFocusMode("sessions")
        setSelectedIndex(Math.max(parentSessions().length - 1, 0))
      }
      e.preventDefault()
      const newIndex = Math.max(selectedIndex() - 1, 0)
      setSelectedIndex(newIndex)
      scrollToIndex(newIndex)
      return
    }
 
    if (!listFocused) {
      return
    }
 
    if (e.key === "PageDown") {
      e.preventDefault()
      const pageSize = 5
      const newIndex = Math.min(selectedIndex() + pageSize, sessions.length - 1)
      setSelectedIndex(newIndex)
      scrollToIndex(newIndex)
    } else if (e.key === "PageUp") {
      e.preventDefault()
      const pageSize = 5
      const newIndex = Math.max(selectedIndex() - pageSize, 0)
      setSelectedIndex(newIndex)
      scrollToIndex(newIndex)
    } else if (e.key === "Home") {
      e.preventDefault()
      setSelectedIndex(0)
      scrollToIndex(0)
    } else if (e.key === "End") {
      e.preventDefault()
      const newIndex = sessions.length - 1
      setSelectedIndex(newIndex)
      scrollToIndex(newIndex)
    } else if (e.key === "Enter") {
      e.preventDefault()
      void handleEnterKey()
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault()
      void handleDeleteKey()
    }
  }


  async function handleEnterKey() {
    const sessions = parentSessions()
    const index = selectedIndex()
 
    if (index < sessions.length) {
      await handleSessionSelect(sessions[index].id)
    }
  }
 
  async function handleDeleteKey() {
    const sessions = parentSessions()
    const index = selectedIndex()
 
    if (index >= sessions.length) {
      return
    }
 
    await handleSessionDelete(sessions[index].id)
 
    const updatedSessions = parentSessions()
    if (updatedSessions.length === 0) {
      setFocusMode("new-session")
      setSelectedIndex(0)
      return
    }
 
    const nextIndex = Math.min(index, updatedSessions.length - 1)
    setSelectedIndex(nextIndex)
    setFocusMode("sessions")
    scrollToIndex(nextIndex)
  }
 
   onMount(() => {
    window.addEventListener("keydown", handleKeyDown)

    onCleanup(() => {
      window.removeEventListener("keydown", handleKeyDown)
    })
  })

  onMount(() => {
    const mediaQuery = window.matchMedia("(min-width: 1024px)")
    const handleMediaChange = (matches: boolean) => {
      setIsDesktopLayout(matches)
      if (matches) {
        closeInstanceInfoOverlay()
      }
    }

    const listener = (event: MediaQueryListEvent) => handleMediaChange(event.matches)

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", listener)
      onCleanup(() => {
        mediaQuery.removeEventListener("change", listener)
      })
    } else {
      mediaQuery.addListener(listener)
      onCleanup(() => {
        mediaQuery.removeListener(listener)
      })
    }

    handleMediaChange(mediaQuery.matches)
  })

  function formatRelativeTime(timestamp: number): string {
    const seconds = Math.floor((Date.now() - timestamp) / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)
    const days = Math.floor(hours / 24)

    if (days > 0) return `${days}d ago`
    if (hours > 0) return `${hours}h ago`
    if (minutes > 0) return `${minutes}m ago`
    return "just now"
  }

  function formatTimestamp(timestamp: number): string {
    return new Date(timestamp).toLocaleString()
  }

  async function handleSessionSelect(sessionId: string) {
    setActiveParentSession(props.instance.id, sessionId)
  }

  async function handleSessionDelete(sessionId: string) {
    if (isSessionDeleting(sessionId)) return

    try {
      await deleteSession(props.instance.id, sessionId)
    } catch (error) {
      log.error("Failed to delete session:", error)
    }
  }

  function openRenameDialogForSession(sessionId: string, title: string) {
    const label = title && title.trim() ? title : sessionId
    setRenameTarget({ id: sessionId, title: title ?? "", label })
  }

  function closeRenameDialog() {
    setRenameTarget(null)
  }

  async function handleRenameSubmit(nextTitle: string) {
    const target = renameTarget()
    if (!target) return

    setIsRenaming(true)
    try {
      await renameSession(props.instance.id, target.id, nextTitle)
      setRenameTarget(null)
    } catch (error) {
      log.error("Failed to rename session:", error)
      showToastNotification({ message: "Unable to rename session", variant: "error" })
    } finally {
      setIsRenaming(false)
    }
  }

  async function handleNewSession() {
    if (isCreating()) return

    setIsCreating(true)

    try {
      const session = await createSession(props.instance.id)
      setActiveParentSession(props.instance.id, session.id)
    } catch (error) {
      log.error("Failed to create session:", error)
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <div class="flex-1 flex flex-col overflow-hidden bg-secondary">
      <div class="flex-1 flex flex-col lg:flex-row gap-4 p-4 overflow-auto min-w-0">
        <div class="flex-1 flex flex-col gap-4 min-h-0 min-w-0">
          <Show
            when={parentSessions().length > 0}
            fallback={
              <Show
                when={isFetchingSessions()}
                fallback={
                  <div class="rounded-lg shadow-sm border border-border overflow-hidden min-w-0 bg-background text-foreground p-6 text-center flex-1 flex flex-col justify-center">
                    <div class="text-muted-foreground mb-2">
                      <svg class="w-12 h-12 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          stroke-width="2"
                          d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                        />
                      </svg>
                    </div>
                    <p class="font-medium text-sm mb-1 text-muted-foreground">No Previous Sessions</p>
                    <p class="text-xs text-muted-foreground">Create a new session below to get started</p>
                    <Show when={!isDesktopLayout() && !showInstanceInfoOverlay()}>
                      <button type="button" class="inline-flex items-center justify-center gap-2 font-medium px-3 py-1.5 rounded-md text-sm transition-colors text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed mt-4 lg:hidden" onClick={openInstanceInfoOverlay}>
                        View Instance Info
                      </button>
                    </Show>
                  </div>
                }
              >
                <div class="rounded-lg shadow-sm border border-border overflow-hidden min-w-0 bg-background text-foreground p-6 text-center flex-1 flex flex-col justify-center">
                  <div class="text-muted-foreground mb-2">
                    <Loader2 class="w-12 h-12 mx-auto animate-spin text-muted-foreground" />
                  </div>
                  <p class="font-medium text-sm mb-1 text-muted-foreground">Loading Sessions</p>
                  <p class="text-xs text-muted-foreground">Fetching your previous sessions...</p>
                </div>
              </Show>
            }
          >
            <div class="rounded-lg shadow-sm border border-border overflow-hidden min-w-0 bg-background text-foreground flex flex-col flex-1 min-h-0">
              <div class="px-4 py-3 border-b border-border bg-secondary">
                <div class="flex flex-row flex-wrap items-center gap-2 justify-between">
                  <div>
                    <h2 class="text-base font-semibold text-foreground">Resume Session</h2>
                    <p class="text-xs mt-0.5 text-muted-foreground">
                      {parentSessions().length} {parentSessions().length === 1 ? "session" : "sessions"} available
                    </p>
                  </div>
                  <Show when={!isDesktopLayout() && !showInstanceInfoOverlay()}>
                    <button
                      type="button"
                      class="inline-flex items-center justify-center gap-2 font-medium px-3 py-1.5 rounded-md text-sm transition-colors text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed lg:hidden flex-shrink-0"
                      onClick={openInstanceInfoOverlay}
                    >
                      View Instance Info
                    </button>
                  </Show>
                </div>
              </div>
              <div class="max-h-none h-full overflow-y-auto w-full min-w-0 overflow-x-hidden flex-1 min-h-0 overflow-auto">
                <For each={parentSessions()}>
                  {(session, index) => {
                    const isFocused = () => focusMode() === "sessions" && selectedIndex() === index()
                    return (
                      <div
                        class={cn(
                          "border-b last:border-b-0 transition-colors w-full border-border hover:bg-accent",
                          isFocused() && "bg-accent shadow-[inset_0_0_0_1px_hsl(var(--border))]",
                        )}
                      >
                        <div class="flex items-center gap-2 w-full px-1">
                          <button
                            type="button"
                            data-session-index={index()}
                            class="flex-1 text-left px-4 py-3 flex items-center justify-between gap-3 outline-none transition-colors w-full min-w-0 group"
                            onClick={() => handleSessionSelect(session.id)}
                            onMouseEnter={() => {
                              setFocusMode("sessions")
                              setSelectedIndex(index())
                            }}
                          >
                            <div class="flex items-center justify-between gap-3 w-full">
                              <div class="flex-1 min-w-0">
                                <div class="flex items-center gap-2">
                                  <span
                                    class="text-sm font-medium text-primary whitespace-normal break-words transition-colors"
                                    classList={{
                                      "text-accent": isFocused(),
                                    }}
                                  >
                                    {session.title || "Untitled Session"}
                                  </span>
                                </div>
                                <div class="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                                  <span>{session.agent}</span>
                                  <span>•</span>
                                  <span>{formatRelativeTime(session.time.updated)}</span>
                                </div>
                              </div>
                            </div>
                          </button>
                          <Show when={isFocused()}>
                            <div class="flex items-center gap-2 flex-shrink-0">
                              <kbd class="kbd flex-shrink-0">↵</kbd>
                              <button
                                type="button"
                                class="p-1.5 rounded transition-colors text-muted-foreground hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                                title="Rename session"
                                onClick={(event) => {
                                  event.preventDefault()
                                  event.stopPropagation()
                                  openRenameDialogForSession(session.id, session.title || "")
                                }}
                              >
                                <Pencil class="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                class="p-1.5 rounded transition-colors text-muted-foreground hover:text-destructive focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                                title="Delete session"
                                disabled={isSessionDeleting(session.id)}
                                onClick={(event) => {
                                  event.preventDefault()
                                  event.stopPropagation()
                                  void handleSessionDelete(session.id)
                                }}
                              >
                                <Show
                                  when={!isSessionDeleting(session.id)}
                                  fallback={
                                    <svg class="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                                      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                                      <path
                                        class="opacity-75"
                                        fill="currentColor"
                                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                                      />
                                    </svg>
                                  }
                                >
                                  <Trash2 class="w-4 h-4" />
                                </Show>
                              </button>
                            </div>
                          </Show>
                        </div>
                      </div>
                    )
                  }}
                </For>
              </div>
            </div>
          </Show>

          <div class="rounded-lg shadow-sm border border-border overflow-hidden min-w-0 bg-background text-foreground flex-shrink-0">
            <div class="px-4 py-3 border-b border-border bg-secondary">
              <h2 class="text-base font-semibold text-foreground">Start New Session</h2>
              <p class="text-xs mt-0.5 text-muted-foreground">We'll reuse your last agent/model automatically</p>
            </div>
            <div class="p-4 bg-background">
              <div class="space-y-3">
                <button
                  type="button"
                  class="inline-flex items-center justify-center gap-2 font-medium px-4 py-2 rounded-md transition-colors bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed w-full flex items-center justify-center text-sm"
                  onClick={handleNewSession}
                  disabled={isCreating()}
                >
                  <div class="flex items-center gap-2">
                    {isCreating() ? (
                      <svg class="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                        <path
                          class="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                        />
                      </svg>
                    ) : (
                      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
                      </svg>
                    )}
                    <span>Create Session</span>
                  </div>
                  <Kbd shortcut={newSessionShortcutString()} class="ml-2" />
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="hidden lg:block lg:w-80 flex-shrink-0">
          <div class="sticky top-0 max-h-full overflow-y-auto pr-1">
            <InstanceInfo instance={props.instance} />
          </div>
        </div>
      </div>

      <Show when={!isDesktopLayout() && showInstanceInfoOverlay()}>
        <div
          class="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={closeInstanceInfoOverlay}
        >
          <div class="flex min-h-full items-start justify-center p-4 overflow-y-auto">
            <div
              class="w-full max-w-md space-y-3"
              onClick={(event) => event.stopPropagation()}
            >
              <div class="flex justify-end">
                <button type="button" class="inline-flex items-center justify-center gap-2 font-medium px-3 py-1.5 rounded-md text-sm transition-colors text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed" onClick={closeInstanceInfoOverlay}>
                  Close
                </button>
              </div>
              <div class="max-h-[85vh] overflow-y-auto pr-1">
                <InstanceInfo instance={props.instance} />
              </div>
            </div>
          </div>
        </div>
      </Show>

      <div class="px-4 py-3 border-t border-border bg-secondary hidden sm:block">

        <div class="flex items-center justify-center flex-wrap gap-3 text-xs text-muted-foreground">
          <div class="flex items-center gap-1.5">
            <kbd class="kbd">↑</kbd>
            <kbd class="kbd">↓</kbd>
            <span>Navigate</span>
          </div>
          <div class="flex items-center gap-1.5">
            <kbd class="kbd">PgUp</kbd>
            <kbd class="kbd">PgDn</kbd>
            <span>Jump</span>
          </div>
          <div class="flex items-center gap-1.5">
            <kbd class="kbd">Home</kbd>
            <kbd class="kbd">End</kbd>
            <span>First/Last</span>
          </div>
          <div class="flex items-center gap-1.5">
            <kbd class="kbd">Enter</kbd>
            <span>Resume</span>
          </div>
          <div class="flex items-center gap-1.5">
            <kbd class="kbd">Del</kbd>
            <span>Delete</span>
          </div>
        </div>
      </div>

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

export default InstanceWelcomeView
