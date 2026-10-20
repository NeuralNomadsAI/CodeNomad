export type SessionSidebarRequestAction =
  | "focus-agent-selector"
  | "focus-model-selector"
  | "focus-variant-selector"
  | "clear-prompt"
  | "show-session-list"

/** Dispatched on a composer's textarea to run that composer's own Clear action. */
export const PROMPT_CLEAR_EVENT = "codenomad:prompt-clear"

export interface SessionSidebarRequestDetail {
  instanceId: string
  action: SessionSidebarRequestAction
}

export const SESSION_SIDEBAR_EVENT = "opencode:session-sidebar-request"

export function emitSessionSidebarRequest(detail: SessionSidebarRequestDetail) {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent<SessionSidebarRequestDetail>(SESSION_SIDEBAR_EVENT, { detail }))
}
