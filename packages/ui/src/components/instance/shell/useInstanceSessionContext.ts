import { createMemo, type Accessor } from "solid-js"
import type { Session } from "../../../types/session"
import {
  activeParentSessionId,
  activeSessionId as activeSessionMap,
  getSessionFamily,
  getSessionInfo,
  getSessionThreads,
  sessions,
  selectActiveSession,
  selectSessionFromList,
} from "../../../stores/sessions"
import { messageStoreBus } from "../../../stores/message-v2/bus"
import type { SessionUsageState } from "../../../stores/message-v2/types"

type InstanceSessionContextOptions = {
  instanceId: Accessor<string>
}

type InstanceSessionContextState = {
  // Session collections and selections
  allInstanceSessions: Accessor<Map<string, Session>>
  sessionThreads: Accessor<ReturnType<typeof getSessionThreads>>
  activeSessions: Accessor<Map<string, SessionFamilyMember>>
  activeSessionIdForInstance: Accessor<string | null>
  parentSessionIdForInstance: Accessor<string | null>
  activeSessionForInstance: Accessor<SessionFamilyMember | null>

  // Usage / info summaries
  activeSessionUsage: Accessor<SessionUsageState | null>
  activeSessionInfoDetails: Accessor<ReturnType<typeof getSessionInfo> | null>
  tokenStats: Accessor<{ used: number; avail: number | null }>

  // Controller
  handleSessionSelect: (sessionId: string) => void
}

type SessionFamilyMember = ReturnType<typeof getSessionFamily>[number]
const EMPTY_INSTANCE_SESSIONS = new Map<string, Session>()

export function useInstanceSessionContext(options: InstanceSessionContextOptions): InstanceSessionContextState {
  const messageStore = createMemo(() => messageStoreBus.getOrCreate(options.instanceId()))

  const allInstanceSessions = createMemo<Map<string, Session>>(() => {
    return sessions().get(options.instanceId()) ?? EMPTY_INSTANCE_SESSIONS
  })

  const sessionThreads = createMemo(() => getSessionThreads(options.instanceId()))

  const activeSessionIdForInstance = createMemo(() => {
    return activeSessionMap().get(options.instanceId()) || null
  })

  const parentSessionIdForInstance = createMemo(() => {
    return activeParentSessionId().get(options.instanceId()) || null
  })

  const activeSessions = createMemo(() => {
    const parentId = parentSessionIdForInstance()
    if (!parentId) return EMPTY_INSTANCE_SESSIONS
    const sessionFamily = getSessionFamily(options.instanceId(), parentId, allInstanceSessions())
    return new Map(sessionFamily.map((s) => [s.id, s]))
  })

  const activeSessionForInstance = createMemo(() => {
    const sessionId = activeSessionIdForInstance()
    if (!sessionId || sessionId === "info") return null
    return activeSessions().get(sessionId) ?? null
  })

  const activeSessionUsage = createMemo(() => {
    const sessionId = activeSessionIdForInstance()
    if (!sessionId) return null
    const store = messageStore()
    return store?.getSessionUsage(sessionId) ?? null
  })

  const activeSessionInfoDetails = createMemo(() => {
    const sessionId = activeSessionIdForInstance()
    if (!sessionId) return null
    return getSessionInfo(options.instanceId(), sessionId) ?? null
  })

  const tokenStats = createMemo(() => {
    const usage = activeSessionUsage()
    const info = activeSessionInfoDetails()
    return {
      used: usage?.actualUsageTokens ?? info?.actualUsageTokens ?? 0,
      avail: info?.contextAvailableTokens ?? null,
    }
  })

  const handleSessionSelect = (sessionId: string) => {
    const instanceId = options.instanceId()
    if (sessionId === "info") {
      selectActiveSession(instanceId, sessionId)
      return
    }

    if (!allInstanceSessions().has(sessionId)) return
    selectSessionFromList(instanceId, sessionId)
  }

  return {
    allInstanceSessions,
    sessionThreads,
    activeSessions,
    activeSessionIdForInstance,
    parentSessionIdForInstance,
    activeSessionForInstance,
    activeSessionUsage,
    activeSessionInfoDetails,
    tokenStats,
    handleSessionSelect,
  }
}
