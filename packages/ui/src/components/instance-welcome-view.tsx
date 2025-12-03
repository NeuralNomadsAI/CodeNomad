import { Component, createSignal, Show, For, createEffect, onMount, onCleanup, createMemo } from "solid-js"
import type { Instance } from "../types/instance"
import { getParentSessions, createSession, setActiveParentSession } from "../stores/sessions"
import InstanceInfo from "./instance-info"
import KeyboardHint from "./keyboard-hint"
import Kbd from "./kbd"
import { keyboardRegistry, type KeyboardShortcut } from "../lib/keyboard-registry"
import { isMac } from "../lib/keyboard-utils"


interface InstanceWelcomeViewProps {
  instance: Instance
}

const InstanceWelcomeView: Component<InstanceWelcomeViewProps> = (props) => {
  const [isCreating, setIsCreating] = createSignal(false)
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [focusMode, setFocusMode] = createSignal<"sessions" | "new-session" | null>("sessions")
  const [showInstanceInfoOverlay, setShowInstanceInfoOverlay] = createSignal(false)

  const parentSessions = () => getParentSessions(props.instance.id)
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

  const openInstanceInfoOverlay = () => setShowInstanceInfoOverlay(true)
  const closeInstanceInfoOverlay = () => setShowInstanceInfoOverlay(false)

  function scrollToIndex(index: number) {
    const element = document.querySelector(`[data-session-index="${index}"]`)
    if (element) {
      element.scrollIntoView({ block: "nearest", behavior: "auto" })
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
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

    if (e.key === "ArrowDown") {
      e.preventDefault()
      const newIndex = Math.min(selectedIndex() + 1, sessions.length - 1)
      setSelectedIndex(newIndex)
      setFocusMode("sessions")
      scrollToIndex(newIndex)
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      const newIndex = Math.max(selectedIndex() - 1, 0)
      setSelectedIndex(newIndex)
      setFocusMode("sessions")
      scrollToIndex(newIndex)
    } else if (e.key === "PageDown") {
      e.preventDefault()
      const pageSize = 5
      const newIndex = Math.min(selectedIndex() + pageSize, sessions.length - 1)
      setSelectedIndex(newIndex)
      setFocusMode("sessions")
      scrollToIndex(newIndex)
    } else if (e.key === "PageUp") {
      e.preventDefault()
      const pageSize = 5
      const newIndex = Math.max(selectedIndex() - pageSize, 0)
      setSelectedIndex(newIndex)
      setFocusMode("sessions")
      scrollToIndex(newIndex)
    } else if (e.key === "Home") {
      e.preventDefault()
      setSelectedIndex(0)
      setFocusMode("sessions")
      scrollToIndex(0)
    } else if (e.key === "End") {
      e.preventDefault()
      const newIndex = sessions.length - 1
      setSelectedIndex(newIndex)
      setFocusMode("sessions")
      scrollToIndex(newIndex)
    } else if (e.key === "Enter") {
      e.preventDefault()
      handleEnterKey()
    }
  }

  async function handleEnterKey() {
    const sessions = parentSessions()
    const index = selectedIndex()

    if (index < sessions.length) {
      await handleSessionSelect(sessions[index].id)
    }
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

  async function handleNewSession() {
    if (isCreating()) return

    setIsCreating(true)
    try {
      const session = await createSession(props.instance.id)
      setActiveParentSession(props.instance.id, session.id)
    } catch (error) {
      console.error("Failed to create session:", error)
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <div class="flex-1 flex flex-col overflow-hidden bg-surface-secondary">
      <div class="flex-1 flex flex-col lg:flex-row gap-4 p-4 overflow-auto">
        <div class="flex-1 flex flex-col gap-4 min-h-0">
          <Show
            when={parentSessions().length > 0}
            fallback={
              <div class="panel panel-empty-state flex-1 flex flex-col justify-center">
                <div class="panel-empty-state-icon">
                  <svg class="w-12 h-12 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                    />
                  </svg>
                </div>
                <p class="panel-empty-state-title">No Previous Sessions</p>
                <p class="panel-empty-state-description">Create a new session below to get started</p>
                <Show when={!showInstanceInfoOverlay()}>
                  <button type="button" class="button-tertiary mt-4 lg:hidden" onClick={openInstanceInfoOverlay}>
                    View Instance Info
                  </button>
                </Show>
              </div>
            }
          >
            <div class="panel flex flex-col flex-1 min-h-0">
              <div class="panel-header">
                <div class="flex flex-row flex-wrap items-center gap-2 justify-between">
                  <div>
                    <h2 class="panel-title">Resume Session</h2>
                    <p class="panel-subtitle">
                      {parentSessions().length} {parentSessions().length === 1 ? "session" : "sessions"} available
                    </p>
                  </div>
                  <Show when={!showInstanceInfoOverlay()}>
                    <button
                      type="button"
                      class="button-tertiary lg:hidden flex-shrink-0"
                      onClick={openInstanceInfoOverlay}
                    >
                      View Instance Info
                    </button>
                  </Show>
                </div>
              </div>
              <div class="panel-list panel-list--fill flex-1 min-h-0 overflow-auto">
                <For each={parentSessions()}>
                  {(session, index) => (
                    <div 
                      class="panel-list-item"
                      classList={{
                        "panel-list-item-highlight": focusMode() === "sessions" && selectedIndex() === index(),
                      }}
                    >
                      <button
                        data-session-index={index()}
                        class="panel-list-item-content group w-full"
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
                                class="text-sm font-medium text-primary truncate transition-colors"
                                classList={{
                                  "text-accent":
                                    focusMode() === "sessions" && selectedIndex() === index(),
                                }}
                              >
                                {session.title || "Untitled Session"}
                              </span>
                            </div>
                            <div class="flex items-center gap-3 text-xs text-muted mt-0.5">
                              <span>{session.agent}</span>
                              <span>•</span>
                              <span>{formatRelativeTime(session.time.updated)}</span>
                            </div>
                          </div>
                          <Show when={focusMode() === "sessions" && selectedIndex() === index()}>
                            <kbd class="kbd flex-shrink-0">↵</kbd>
                          </Show>
                        </div>
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Show>

          <div class="panel flex-shrink-0">
            <div class="panel-header">
              <h2 class="panel-title">Start New Session</h2>
              <p class="panel-subtitle">We’ll reuse your last agent/model automatically</p>
            </div>
            <div class="panel-body">
              <div class="space-y-3">
                <button
                  type="button"
                  class="button-primary w-full flex items-center justify-center text-sm disabled:cursor-not-allowed"
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
          <div class="sticky top-0">
            <InstanceInfo instance={props.instance} />
          </div>
        </div>
      </div>

      <Show when={showInstanceInfoOverlay()}>
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
                <button type="button" class="button-tertiary" onClick={closeInstanceInfoOverlay}>
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

      <div class="panel-footer hidden sm:block">
        <div class="panel-footer-hints">
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
          <KeyboardHint shortcuts={[newSessionShortcut()]} separator="" />
        </div>
      </div>
    </div>
  )
}

export default InstanceWelcomeView

