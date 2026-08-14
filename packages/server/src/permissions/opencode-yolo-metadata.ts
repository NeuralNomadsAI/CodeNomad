import type { OpenCodeClient, SessionInfo } from "@opencode-ai/client"
import type { SettingsService } from "../settings/service"
import type { WorkspaceManager } from "../workspaces/manager"
import { createInstanceClient } from "../workspaces/instance-client"
import type { AutoAcceptPersistence, PersistedAutoAcceptSession } from "./auto-accept-manager"

const SESSION_LIST_LIMIT = 10_000
const STATE_OWNER = "codenomad"

type Metadata = Record<string, unknown>

interface PersistedSessionState {
  yoloEnabled?: boolean
}

export type OpencodeYoloPersistence = AutoAcceptPersistence

function record(value: unknown): Metadata {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Metadata) } : {}
}

function sessionState(settings: SettingsService, sessionId: string): PersistedSessionState {
  const sessions = record(settings.getOwner("state", STATE_OWNER).sessions)
  return record(sessions[sessionId]) as PersistedSessionState
}

function enabledSessionIds(settings: SettingsService): string[] {
  const sessions = record(settings.getOwner("state", STATE_OWNER).sessions)
  return Object.keys(sessions).filter((sessionId) => record(sessions[sessionId]).yoloEnabled === true)
}

export function createOpencodeYoloPersistence(
  workspaceManager: WorkspaceManager,
  settings: SettingsService,
  createClient: (manager: WorkspaceManager, instanceId: string) => Promise<OpenCodeClient | null> = createInstanceClient,
): OpencodeYoloPersistence {
  const writes = new Map<string, Promise<unknown>>()
  const clientFor = async (instanceId: string) => {
    const client = await createClient(workspaceManager, instanceId)
    if (!client) throw new Error(`Yolo: instance ${instanceId} is not ready`)
    return client
  }
  const listSessions = async (instanceId: string) => {
    const workspace = workspaceManager.get(instanceId)
    if (!workspace) throw new Error(`Yolo: instance ${instanceId} is not ready`)
    const directory = workspaceManager.getServiceDirectory(instanceId)
    if (!directory) throw new Error(`Yolo: instance ${instanceId} has no service location`)
    const client = await clientFor(instanceId)
    const sessions: SessionInfo[] = []
    let cursor: string | undefined
    do {
      const page = await client.session.list({ directory, limit: SESSION_LIST_LIMIT, cursor })
      sessions.push(...page.data)
      cursor = page.cursor.next ?? undefined
    } while (cursor)
    return sessions
  }
  const persistedSession = (session: SessionInfo): PersistedAutoAcceptSession => ({
    id: session.id,
    parentId: session.parentID ?? null,
    fork: session.fork,
    workspaceId: session.location.workspaceID,
    yoloEnabled: sessionState(settings, session.id).yoloEnabled === true,
  })
  const updateYolo = (
    sessionId: string,
    enabled: boolean,
  ): Promise<void> => {
    const write = (writes.get(sessionId) ?? Promise.resolve()).catch(() => undefined).then(() => {
      const next = { ...sessionState(settings, sessionId), yoloEnabled: enabled }
      settings.mergePatchOwner("state", STATE_OWNER, { sessions: { [sessionId]: next } })
    })
    const settled = write.finally(() => {
      if (writes.get(sessionId) === settled) writes.delete(sessionId)
    })
    writes.set(sessionId, settled)
    return settled
  }

  return {
    async loadSessions(instanceId): Promise<PersistedAutoAcceptSession[]> {
      const client = await clientFor(instanceId)
      const sessions = new Map((await listSessions(instanceId)).map((session) => [session.id, session]))
      await Promise.all(enabledSessionIds(settings).map(async (sessionId) => {
        if (sessions.has(sessionId)) return
        try {
          const session = await client.session.get({ sessionID: sessionId })
          if (await workspaceManager.ownsDirectory(instanceId, session.location.directory)) sessions.set(session.id, session)
        } catch {
          // Stale persisted IDs are harmless and may belong to a stopped workspace.
        }
      }))
      const owned = await Promise.all(Array.from(sessions.values()).map(async (session) => (
        await workspaceManager.ownsDirectory(instanceId, session.location.directory) ? persistedSession(session) : null
      )))
      return owned.filter((session): session is PersistedAutoAcceptSession => session !== null)
    },
    async loadSession(instanceId, sessionId): Promise<PersistedAutoAcceptSession | null> {
      try {
        const session = await (await clientFor(instanceId)).session.get({ sessionID: sessionId })
        if (!(await workspaceManager.ownsDirectory(instanceId, session.location.directory))) return null
        return persistedSession(session)
      } catch {
        return null
      }
    },
    persist(_instanceId, rootSessionId, enabled): Promise<void> {
      return updateYolo(rootSessionId, enabled)
    },
  }
}
