import { batch, createMemo, type Accessor } from "solid-js"
import type { ToolState } from "@opencode-ai/sdk"
import type { Session } from "../../../types/session"
import {
  activeParentSessionId,
  activeSessionId as activeSessionMap,
  getSessionFamily,
  getSessionInfo,
  getSessionThreads,
  sessions,
  setActiveParentSession,
  setActiveSession,
} from "../../../stores/sessions"
import { messageStoreBus } from "../../../stores/message-v2/bus"
import { getBackgroundProcesses } from "../../../stores/background-processes"
import type { LatestTodoSnapshot, SessionUsageState } from "../../../stores/message-v2/types"

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
  activeSessionDiffs: Accessor<SessionFamilyMember["diff"] | undefined>

  // Usage / info summaries
  activeSessionUsage: Accessor<SessionUsageState | null>
  activeSessionInfoDetails: Accessor<ReturnType<typeof getSessionInfo> | null>
  tokenStats: Accessor<{ used: number; avail: number | null }>

  // Todo state
  latestTodoSnapshot: Accessor<LatestTodoSnapshot | null>
  latestTodoState: Accessor<ToolState | null>

  // Background processes
  backgroundProcessList: Accessor<ReturnType<typeof getBackgroundProcesses>>

  // Controller
  handleSessionSelect: (sessionId: string) => void
}

type SessionFamilyMember = ReturnType<typeof getSessionFamily>[number]

export function useInstanceSessionContext(options: InstanceSessionContextOptions): InstanceSessionContextState {
  const messageStore = createMemo(() => messageStoreBus.getOrCreate(options.instanceId()))

  const allInstanceSessions = createMemo<Map<string, Session>>(() => {
    return sessions().get(options.instanceId()) ?? new Map()
  })

  const sessionThreads = createMemo(() => getSessionThreads(options.instanceId()))

  const activeSessions = createMemo(() => {
    const parentId = activeParentSessionId().get(options.instanceId())
    if (!parentId) return new Map<string, ReturnType<typeof getSessionFamily>[number]>()
    const sessionFamily = getSessionFamily(options.instanceId(), parentId)
    return new Map(sessionFamily.map((s) => [s.id, s]))
  })

  const activeSessionIdForInstance = createMemo(() => {
    return activeSessionMap().get(options.instanceId()) || null
  })

  const parentSessionIdForInstance = createMemo(() => {
    return activeParentSessionId().get(options.instanceId()) || null
  })

  const activeSessionForInstance = createMemo(() => {
    const sessionId = activeSessionIdForInstance()
    if (!sessionId || sessionId === "info") return null
    return activeSessions().get(sessionId) ?? null
  })

  const activeSessionDiffs = createMemo(() => {
    const session = activeSessionForInstance()
    return session?.diff
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

  const latestTodoSnapshot = createMemo(() => {
    const sessionId = activeSessionIdForInstance()
    if (!sessionId || sessionId === "info") return null
    const store = messageStore()
    if (!store) return null
    const snapshot = store.state.latestTodos[sessionId]
    return snapshot ?? null
  })

  const latestTodoState = createMemo<ToolState | null>(() => {
    const snapshot = latestTodoSnapshot()
    if (!snapshot) return null
    const store = messageStore()
    if (!store) return null
    const message = store.getMessage(snapshot.messageId)
    if (!message) return null
    const partRecord = message.parts?.[snapshot.partId]
    const part = partRecord?.data as { type?: string; tool?: string; state?: ToolState }
    if (!part || part.type !== "tool" || part.tool !== "todowrite") return null
    const state = part.state
    if (!state || state.status !== "completed") return null
    return state
  })

  const backgroundProcessList = createMemo(() => getBackgroundProcesses(options.instanceId()))

  const handleSessionSelect = (sessionId: string) => {
    const instanceId = options.instanceId()
    if (sessionId === "info") {
      setActiveSession(instanceId, sessionId)
      return
    }

    const session = allInstanceSessions().get(sessionId)
    if (!session) return

    if (session.parentId === null) {
      setActiveParentSession(instanceId, sessionId)
      return
    }

    const parentId = session.parentId
    if (!parentId) return

    batch(() => {
      setActiveParentSession(instanceId, parentId)
      setActiveSession(instanceId, sessionId)
    })
  }

  return {
    allInstanceSessions,
    sessionThreads,
    activeSessions,
    activeSessionIdForInstance,
    parentSessionIdForInstance,
    activeSessionForInstance,
    activeSessionDiffs,
    activeSessionUsage,
    activeSessionInfoDetails,
    tokenStats,
    latestTodoSnapshot,
    latestTodoState,
    backgroundProcessList,
    handleSessionSelect,
  }
}
