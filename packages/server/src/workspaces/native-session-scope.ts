import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { WorkspaceManager } from "./manager"
import { createInstanceClient } from "./instance-client"

const SESSION_LIMIT = 10_000

function sameDirectory(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false
  const normalize = (value: string) => {
    const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "")
    return /^[a-z]:\//i.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized
  }
  return normalize(left) === normalize(right)
}

export async function resolveNativeSessionScope(
  workspaceManager: WorkspaceManager,
  instanceId: string,
  sessionId: string,
): Promise<{ client: OpencodeClient; directory: string; workspace?: string }> {
  const rootDirectory = await workspaceManager.resolveInstanceDirectory(instanceId)
  const rootClient = createInstanceClient(workspaceManager, instanceId, { directory: rootDirectory })
  if (!rootClient) throw new Error("Workspace instance is not ready")
  const scope = { directory: rootDirectory }
  await rootClient.experimental.workspace.syncList(scope, { throwOnError: true })
  const [{ data: workspaces = [] }, { data: sessions = [] }] = await Promise.all([
    rootClient.experimental.workspace.list(scope, { throwOnError: true }),
    rootClient.session.list({ ...scope, scope: "project", limit: SESSION_LIMIT } as any, { throwOnError: true }),
  ])
  if (sessions.length >= SESSION_LIMIT) throw new Error("Unable to verify the complete project session inventory")
  const matches = sessions.filter((session) => session.id === sessionId)
  if (matches.length !== 1) throw new Error(`Session ${sessionId} location is missing or ambiguous`)
  const session = matches[0]!
  if (session.workspaceID) {
    const workspace = workspaces.find((candidate) => candidate.id === session.workspaceID)
    if (!workspace?.directory) throw new Error(`Native workspace ${session.workspaceID} is unavailable`)
    const client = createInstanceClient(workspaceManager, instanceId, { directory: workspace.directory })
    if (!client) throw new Error("Workspace instance is not ready")
    return { client, directory: workspace.directory, workspace: workspace.id }
  }
  if (!session.directory || !sameDirectory(session.directory, rootDirectory)) {
    throw new Error(`Session ${sessionId} root location is unresolved`)
  }
  return { client: rootClient, directory: rootDirectory }
}
