import type { SessionInfo } from "./session-state"

import { sseManager } from "../lib/sse-manager"

import {
  activeParentSessionId,
  activeSessionId,
  agents,
  clearActiveParentSession,
  clearInstanceDraftPrompts,
  clearSessionDraftPrompt,
  ensureSessionExpanded,
  getActiveParentSession,
  getActiveSession,
  getChildSessions,
  getParentSessions,
  getSessionDraftPrompt,
  getSessionFamily,
  getSessionInfo,
  getSessionThreads,
  getThreadTotals,
  getSessions,
  getVisibleSessionIds,
  isSessionBusy,
  isSessionMessagesLoading,
  isSessionExpanded,
  loading,
  markSessionIdleSeen,
  markViewedSessionIdleSeen,
  providers,
  sessionInfoByInstance,
  sessions,
  setActiveParentSession,
  setActiveSession,
  setActiveSessionFromList,
  setSessionDraftPrompt,
  setSessionExpanded,
  setSessionStatus,
  toggleSessionExpanded,
} from "./session-state"

import { getDefaultModel } from "./session-models"
import {
  createSession,
  deleteSession,
  fetchAgents,
  fetchProviders,
  fetchSessions,
  fetchSessionChildren,
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
  handleMessagePartDelta,
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
sseManager.onMessagePartDelta = handleMessagePartDelta
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
  ensureSessionExpanded,
  executeCustomCommand,
  renameSession,
  runShellCommand,
  fetchAgents,
  fetchProviders,
  fetchSessions,
  fetchSessionChildren,
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
  getThreadTotals,
  getSessions,
  getVisibleSessionIds,
  isSessionBusy,
  isSessionMessagesLoading,
  isSessionExpanded,
  loadMessages,
  loading,
  markSessionIdleSeen,
  markViewedSessionIdleSeen,
  providers,
  sendMessage,
  sessionInfoByInstance,
  sessions,
  setActiveParentSession,
  setActiveSession,
  setActiveSessionFromList,
  setSessionDraftPrompt,
  setSessionExpanded,
  setSessionStatus,
  toggleSessionExpanded,
  updateSessionAgent,
  updateSessionModel,
}
export type { SessionInfo }
