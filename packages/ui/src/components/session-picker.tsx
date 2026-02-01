import { Component, createSignal, Show, For, createEffect } from "solid-js"
import { Dialog } from "@kobalte/core/dialog"
import type { Session, Agent } from "../types/session"
import { getParentSessions, createSession, setActiveParentSession } from "../stores/sessions"
import { instances, stopInstance } from "../stores/instances"
import { agents } from "../stores/sessions"
import { getLogger } from "../lib/logger"
import { cn } from "../lib/cn"
const log = getLogger("session")


interface SessionPickerProps {
  instanceId: string
  open: boolean
  onClose: () => void
}

const SessionPicker: Component<SessionPickerProps> = (props) => {
  const [selectedAgent, setSelectedAgent] = createSignal<string>("")
  const [isCreating, setIsCreating] = createSignal(false)

  const instance = () => instances().get(props.instanceId)
  const parentSessions = () => getParentSessions(props.instanceId)
  const agentList = () => agents().get(props.instanceId) || []

  createEffect(() => {
    const list = agentList()
    if (list.length === 0) {
      setSelectedAgent("")
      return
    }
    const current = selectedAgent()
    if (!current || !list.some((agent) => agent.name === current)) {
      setSelectedAgent(list[0].name)
    }
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

  async function handleSessionSelect(sessionId: string) {
    setActiveParentSession(props.instanceId, sessionId)
    props.onClose()
  }

  async function handleNewSession() {
    setIsCreating(true)
    try {
      const session = await createSession(props.instanceId, selectedAgent())
      setActiveParentSession(props.instanceId, session.id)
      props.onClose()
    } catch (error) {
      log.error("Failed to create session:", error)
    } finally {
      setIsCreating(false)
    }
  }

  async function handleCancel() {
    await stopInstance(props.instanceId)
    props.onClose()
  }

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && handleCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay class="fixed inset-0 z-50 bg-black/50" />
        <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
          <Dialog.Content class="rounded-lg shadow-2xl flex flex-col bg-background text-foreground w-full max-w-lg p-6">
            <Dialog.Title class="text-xl font-semibold text-primary mb-4">
              OpenCode • {instance()?.folder.split("/").pop()}
            </Dialog.Title>

            <div class="space-y-6">
              <Show
                when={parentSessions().length > 0}
                fallback={<div class="text-center py-4 text-sm text-muted-foreground">No previous sessions</div>}
              >
                <div>
                  <h3 class="text-sm font-medium text-muted-foreground mb-2">
                    Resume a session ({parentSessions().length}):
                  </h3>
                  <div class="space-y-1 max-h-[400px] overflow-y-auto">
                    <For each={parentSessions()}>
                      {(session) => (
                        <button
                          type="button"
                          class="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-accent transition-colors w-full text-left focus:bg-accent"
                          onClick={() => handleSessionSelect(session.id)}
                        >
                          <div class="flex flex-col flex-1 min-w-0 w-full">
                            <span class="text-sm font-medium text-foreground truncate">
                              {session.title || "Untitled"}
                            </span>
                          </div>
                          <span class="inline-flex items-center px-1.5 py-0.5 text-[10px] text-muted-foreground flex-shrink-0">
                            {formatRelativeTime(session.time.updated)}
                          </span>
                        </button>
                      )}
                    </For>
                  </div>
                </div>
              </Show>

              <div class="relative">
                <div class="absolute inset-0 flex items-center">
                  <div class="w-full border-t border-border" />
                </div>
                <div class="relative flex justify-center text-sm">
                  <span class="px-2 bg-surface-base text-muted-foreground">or</span>
                </div>
              </div>

              <div>
                <h3 class="text-sm font-medium text-muted-foreground mb-2">Start new session:</h3>
                <div class="space-y-3">
                  <Show
                    when={agentList().length > 0}
                    fallback={<div class="text-sm text-muted-foreground">Loading agents...</div>}
                  >
                    <select
                      class="w-full px-3 py-2 text-sm bg-transparent border-b border-border outline-none placeholder:text-muted-foreground"
                      value={selectedAgent()}
                      onChange={(e) => setSelectedAgent(e.currentTarget.value)}
                    >
                      <For each={agentList()}>{(agent) => <option value={agent.name}>{agent.name}</option>}</For>
                    </select>
                  </Show>

                  <button
                    class="inline-flex items-center justify-center gap-2 font-medium px-4 py-2 rounded-md transition-colors bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed w-full flex items-center justify-center text-sm"
                    onClick={handleNewSession}
                    disabled={isCreating() || agentList().length === 0}
                  >
                    <div class="flex items-center gap-2">
                      <Show
                        when={!isCreating()}
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
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
                        </svg>
                      </Show>
                      <Show
                        when={!isCreating()}
                        fallback={<span>Creating...</span>}
                      >
                        <span>{agentList().length === 0 ? "Loading agents..." : "Create Session"}</span>
                      </Show>
                    </div>
                    <kbd class="kbd ml-2">
                      Cmd+Enter
                    </kbd>
                  </button>
                </div>
              </div>
            </div>

            <div class="mt-6 flex justify-end">
              <button
                type="button"
                class="inline-flex items-center justify-center gap-2 font-medium px-4 py-2 rounded-md transition-colors border border-border bg-background text-foreground hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={handleCancel}
              >
                Cancel
              </button>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  )
}

export default SessionPicker
