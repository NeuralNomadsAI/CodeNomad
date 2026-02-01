import type { SessionInfo, SessionThread } from "./session-state"

import { sseManager } from "../lib/sse-manager"

import {
  activeParentSessionId,
  activeSessionId,
  agents,
  clearActiveParentSession,
  clearInstanceDraftPrompts,
  clearSessionDraftPrompt,
  getActiveParentSession,
  getActiveSession,
  getChildSessions,
  getParentSessions,
  getSessionDraftPrompt,
  getSessionFamily,
  getSessionInfo,
  getSessions,
  getSessionThreads,
  isSessionBusy,
  isSessionMessagesLoading,
  loading,
  providers,
  sessionInfoByInstance,
  sessions,
  setActiveParentSession,
  setActiveSession,
  setSessionDraftPrompt,
  setSessionStatus,
} from "./session-state"

import { getDefaultModel } from "./session-models"
import {
  createSession,
  deleteSession,
  fetchAgents,
  fetchProviders,
  fetchSessions,
  forkSession,
  loadMessages,
} from "./session-api"
import {
  abortSession,
  executeCustomCommand,
  renameSession,
  runShellCommand,
  sendMessage,
  updateSessionAgent,
  updateSessionModel,
} from "./session-actions"
import {
  handleMessagePartRemoved,
  handleMessageRemoved,
  handleMessageUpdate,
  handlePermissionReplied,
  handlePermissionUpdated,
  handleSessionCompacted,
  handleSessionError,
  handleSessionIdle,
  handleSessionUpdate,
  handleTuiToast,
  handleQuestionEvent,
} from "./session-events"

sseManager.onMessageUpdate = handleMessageUpdate
sseManager.onMessagePartUpdated = handleMessageUpdate
sseManager.onMessageRemoved = handleMessageRemoved
sseManager.onMessagePartRemoved = handleMessagePartRemoved
sseManager.onSessionUpdate = handleSessionUpdate
sseManager.onSessionCompacted = handleSessionCompacted
sseManager.onSessionError = handleSessionError
sseManager.onSessionIdle = handleSessionIdle
sseManager.onTuiToast = handleTuiToast
sseManager.onPermissionUpdated = handlePermissionUpdated
sseManager.onPermissionReplied = handlePermissionReplied
sseManager.onQuestionEvent = handleQuestionEvent

// When connection is restored after disconnect, re-fetch the session list
// and reload messages for all sessions to sync UI state with actual OpenCode state
sseManager.onConnectionRestored = async (instanceId: string) => {
  // Re-fetch session list — may have changed while disconnected
  try {
    await fetchSessions(instanceId)
  } catch (error) {
    console.error(`Failed to re-fetch sessions for instance ${instanceId} after reconnect:`, error)
  }

  const instanceSessions = sessions().get(instanceId)
  if (!instanceSessions) return

  // Reload messages for all sessions to sync state
  const reloadPromises: Promise<void>[] = []
  for (const [sessionId] of instanceSessions) {
    reloadPromises.push(
      loadMessages(instanceId, sessionId, true).catch((error) => {
        console.error(`Failed to reload messages for session ${sessionId} after reconnect:`, error)
      })
    )
  }
  await Promise.all(reloadPromises)
}

export {
  abortSession,
  activeParentSessionId,
  activeSessionId,
  agents,
  clearActiveParentSession,
  clearInstanceDraftPrompts,
  clearSessionDraftPrompt,
  createSession,
  deleteSession,
  executeCustomCommand,
  renameSession,
  runShellCommand,
  fetchAgents,
  fetchProviders,
  fetchSessions,
  forkSession,
  getActiveParentSession,
  getActiveSession,
  getChildSessions,
  getDefaultModel,
  getParentSessions,
  getSessionDraftPrompt,
  getSessionFamily,
  getSessionInfo,
  getSessions,
  getSessionThreads,
  isSessionBusy,
  isSessionMessagesLoading,
  loadMessages,
  loading,
  providers,
  sendMessage,
  sessionInfoByInstance,
  sessions,
  setActiveParentSession,
  setActiveSession,
  setSessionDraftPrompt,
  setSessionStatus,
  updateSessionAgent,
  updateSessionModel,
}
export type { SessionInfo, SessionThread }
