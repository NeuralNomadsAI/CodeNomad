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
  handleSessionStatus,
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
sseManager.onSessionStatus = handleSessionStatus
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
export type { SessionInfo }
