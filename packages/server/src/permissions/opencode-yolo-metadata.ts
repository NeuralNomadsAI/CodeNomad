import type { OpenCodeClient } from "@opencode-ai/client"
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
    return (await (await clientFor(instanceId)).session.list({
      directory: workspace.path,
      limit: SESSION_LIST_LIMIT,
    })).data
  }
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
      return (await listSessions(instanceId)).map((session) => ({
        id: session.id,
        parentId: session.parentID ?? null,
        revert: session.revert,
        workspaceId: session.location.workspaceID,
        yoloEnabled: sessionState(settings, session.id).yoloEnabled === true,
      }))
    },
    persist(_instanceId, rootSessionId, enabled): Promise<void> {
      return updateYolo(rootSessionId, enabled)
    },
  }
}
