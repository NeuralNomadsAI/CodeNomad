import type { SessionInfo } from "./session-state"

import { sseManager } from "../lib/sse-manager"

import {
  activeParentSessionId,
  activeSessionId,
  agents,
  clearActiveParentSession,
  clearInstanceDraftPrompts,
  clearSessionDraftPrompt,
  ensureSessionParentExpanded,
  getActiveParentSession,
  getActiveSession,
  getChildSessions,
  getParentSessions,
  getSessionDraftPrompt,
  getSessionFamily,
  getSessionInfo,
  getSessionThreads,
  getSessions,
  getVisibleSessionIds,
  isSessionBusy,
  isSessionMessagesLoading,
  isSessionParentExpanded,
  loading,
  providers,
  sessionInfoByInstance,
  sessions,
  setActiveParentSession,
  setActiveSession,
  setActiveSessionFromList,
  setSessionDraftPrompt,
  setSessionParentExpanded,
  setSessionStatus,
  toggleSessionParentExpanded,
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
  handleQuestionAnswered,
  handleQuestionAsked,
  handleSessionCompacted,
  handleSessionDiff,
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
sseManager.onSessionDiff = handleSessionDiff
sseManager.onSessionError = handleSessionError
sseManager.onSessionIdle = handleSessionIdle
sseManager.onSessionStatus = handleSessionStatus
sseManager.onTuiToast = handleTuiToast
sseManager.onPermissionUpdated = handlePermissionUpdated
sseManager.onPermissionReplied = handlePermissionReplied
sseManager.onQuestionAsked = handleQuestionAsked
sseManager.onQuestionAnswered = handleQuestionAnswered

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
  ensureSessionParentExpanded,
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
  getSessionThreads,
  getSessions,
  getVisibleSessionIds,
  isSessionBusy,
  isSessionMessagesLoading,
  isSessionParentExpanded,
  loadMessages,
  loading,
  providers,
  sendMessage,
  sessionInfoByInstance,
  sessions,
  setActiveParentSession,
  setActiveSession,
  setActiveSessionFromList,
  setSessionDraftPrompt,
  setSessionParentExpanded,
  setSessionStatus,
  toggleSessionParentExpanded,
  updateSessionAgent,
  updateSessionModel,
}
export type { SessionInfo }
