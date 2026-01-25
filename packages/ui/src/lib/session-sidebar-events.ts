export type SessionSidebarRequestAction =
  | "focus-agent-selector"
  | "focus-model-selector"
  | "focus-variant-selector"
  | "show-session-list"

export interface SessionSidebarRequestDetail {
  instanceId: string
  action: SessionSidebarRequestAction
}

export const SESSION_SIDEBAR_EVENT = "opencode:session-sidebar-request"

export function emitSessionSidebarRequest(detail: SessionSidebarRequestDetail) {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent<SessionSidebarRequestDetail>(SESSION_SIDEBAR_EVENT, { detail }))
}
