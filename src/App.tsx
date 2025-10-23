import { Component, onMount, Show, createMemo, createEffect } from "solid-js"
import type { Session } from "./types/session"
import EmptyState from "./components/empty-state"
import SessionPicker from "./components/session-picker"
import InstanceTabs from "./components/instance-tabs"
import SessionTabs from "./components/session-tabs"
import MessageStream from "./components/message-stream"
import PromptInput from "./components/prompt-input"
import {
  hasInstances,
  isSelectingFolder,
  setIsSelectingFolder,
  setHasInstances,
  sessionPickerInstance,
  hideSessionPicker,
  showSessionPicker,
} from "./stores/ui"
import {
  createInstance,
  instances,
  updateInstance,
  activeInstanceId,
  setActiveInstanceId,
  stopInstance,
  getActiveInstance,
} from "./stores/instances"
import {
  getSessions,
  activeSessionId,
  setActiveSession,
  setActiveParentSession,
  clearActiveParentSession,
  createSession,
  deleteSession,
  getSessionFamily,
  activeParentSessionId,
  getParentSessions,
  loadMessages,
  sendMessage,
  updateSessionAgent,
  updateSessionModel,
} from "./stores/sessions"
import { setupTabKeyboardShortcuts } from "./lib/keyboard"

const SessionView: Component<{
  sessionId: string
  activeSessions: Map<string, Session>
  instanceId: string
}> = (props) => {
  const session = () => props.activeSessions.get(props.sessionId)

  createEffect(() => {
    const currentSession = session()
    if (currentSession) {
      loadMessages(props.instanceId, currentSession.id).catch(console.error)
    }
  })

  async function handleSendMessage(prompt: string) {
    await sendMessage(props.instanceId, props.sessionId, prompt)
  }

  async function handleAgentChange(agent: string) {
    await updateSessionAgent(props.instanceId, props.sessionId, agent)
  }

  async function handleModelChange(model: { providerId: string; modelId: string }) {
    await updateSessionModel(props.instanceId, props.sessionId, model)
  }

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
          />
          <PromptInput
            instanceId={props.instanceId}
            sessionId={s().id}
            onSend={handleSendMessage}
            agent={s().agent}
            model={s().model}
            onAgentChange={handleAgentChange}
            onModelChange={handleModelChange}
          />
        </div>
      )}
    </Show>
  )
}

const App: Component = () => {
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

  async function handleSelectFolder() {
    setIsSelectingFolder(true)
    try {
      const folder = await window.electronAPI.selectFolder()
      if (!folder) {
        return
      }

      const instanceId = await createInstance(folder)
      setHasInstances(true)

      console.log("Created instance:", instanceId, "Port:", instances().get(instanceId)?.port)
    } catch (error) {
      console.error("Failed to create instance:", error)
    } finally {
      setIsSelectingFolder(false)
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

    const isParent = session?.parentId === null

    if (!isParent) {
      return
    }

    clearActiveParentSession(instanceId)
    showSessionPicker(instanceId)
  }

  onMount(() => {
    setupTabKeyboardShortcuts(handleSelectFolder, handleNewSession, handleCloseSession)

    window.electronAPI.onNewInstance(() => {
      handleSelectFolder()
    })

    window.electronAPI.onInstanceStarted(({ id, port, pid }) => {
      console.log("Instance started:", { id, port, pid })
      updateInstance(id, { port, pid, status: "ready" })
    })

    window.electronAPI.onInstanceError(({ id, error }) => {
      console.error("Instance error:", { id, error })
      updateInstance(id, { status: "error", error })
    })

    window.electronAPI.onInstanceStopped(({ id }) => {
      console.log("Instance stopped:", id)
      updateInstance(id, { status: "stopped" })
    })
  })

  return (
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
              onNew={handleSelectFolder}
            />

            <Show when={activeInstance()}>
              {(instance) => (
                <>
                  <Show
                    when={activeSessions().size > 0}
                    fallback={
                      <div class="flex-1 flex items-center justify-center">
                        <div class="text-center text-gray-500">
                          <p class="mb-2">No parent session selected</p>
                          <p class="text-sm">Select or create a parent session to begin</p>
                        </div>
                      </div>
                    }
                  >
                    <SessionTabs
                      instanceId={instance().id}
                      sessions={activeSessions()}
                      activeSessionId={activeSessionIdForInstance()}
                      onSelect={(id) => setActiveSession(instance().id, id)}
                      onClose={(id) => handleCloseSession(instance().id, id)}
                      onNew={() => handleNewSession(instance().id)}
                    />

                    <div class="content-area flex-1 overflow-hidden flex flex-col">
                      <Show
                        when={activeSessionIdForInstance() === "logs"}
                        fallback={
                          <Show
                            when={activeSessionIdForInstance()}
                            fallback={
                              <div class="flex items-center justify-center h-full">
                                <div class="text-center text-gray-500">
                                  <p class="mb-2">No session selected</p>
                                  <p class="text-sm">Select a session to view messages</p>
                                </div>
                              </div>
                            }
                          >
                            <SessionView
                              sessionId={activeSessionIdForInstance()!}
                              activeSessions={activeSessions()}
                              instanceId={activeInstance()!.id}
                            />
                          </Show>
                        }
                      >
                        <div class="p-4 text-gray-600">
                          <p class="font-semibold mb-2">Server Logs</p>
                          <p class="text-sm">Log viewer will be implemented in Task 013</p>
                        </div>
                      </Show>
                    </div>
                  </Show>
                </>
              )}
            </Show>
          </>
        }
      >
        <EmptyState onSelectFolder={handleSelectFolder} isLoading={isSelectingFolder()} />
      </Show>

      <Show when={sessionPickerInstance()}>
        {(instanceId) => <SessionPicker instanceId={instanceId()} open={true} onClose={hideSessionPicker} />}
      </Show>
    </div>
  )
}

export default App
