export const NO_SESSION_DRAFT_SESSION_ID = "__no_session_draft__"
export const RECOVERED_DRAFT_PREFIX = "__recovered_draft__"
export const isRecoveredDraftId = (id: string) => /^__recovered_draft__[a-f\d-]{36}$/.test(id)
export const isLocalDraftId = (id: string) => id === NO_SESSION_DRAFT_SESSION_ID || isRecoveredDraftId(id)
