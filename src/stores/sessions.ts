import type { SessionInfo } from "./session-state"

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
  isSessionBusy,
  isSessionMessagesLoading,
  loading,
  providers,
  sessionInfoByInstance,
  sessions,
  setActiveParentSession,
  setActiveSession,
  setSessionDraftPrompt,
} from "./session-state"
import { getDefaultModel } from "./session-models"
import { computeDisplayParts, removeSessionIndexes } from "./session-messages"
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

export {
  abortSession,
  activeParentSessionId,
  activeSessionId,
  agents,
  clearActiveParentSession,
  clearInstanceDraftPrompts,
  clearSessionDraftPrompt,
  computeDisplayParts,
  createSession,
  deleteSession,
  executeCustomCommand,
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
  isSessionBusy,
  isSessionMessagesLoading,
  loadMessages,
  loading,
  providers,
  removeSessionIndexes,
  sendMessage,
  sessionInfoByInstance,
  sessions,
  setActiveParentSession,
  setActiveSession,
  setSessionDraftPrompt,
  updateSessionAgent,
  updateSessionModel,
}
export type { SessionInfo }
