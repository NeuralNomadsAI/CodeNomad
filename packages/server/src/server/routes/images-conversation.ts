import { z } from "zod"
import type { FastifyInstance } from "fastify"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { excludeDesignFolder } from "../../workspaces/design-git-exclude"
import { locationRequestOptions, readLocationRef } from "../../opencode/compatibility/location"
import { PRUNING_RPC_ID } from "../../opencode/session-pruning/contract"
import { imagesConversationInputSchema, imagesConversationResultSchema, type ImagesConversationInput } from "../../opencode/session-pruning/assets-gallery-contract"
import type { GitExclusion, ImagesConversationResponse } from "./images-conversation-contract"
import type { ServiceConnection } from "../../workspaces/opencode-service"

export interface ImagesConversationRouteDeps {
  workspaceManager: Pick<WorkspaceManager, "get" | "getServiceLocation" | "getSharedServiceConnection" | "ownsLocation" | "getWorktreeIdentityForPath" | "desktopPluginsReady"
    | "getServiceWslDistro" | "getHostPathForServicePath">
  worktreeDeletionFence: WorktreeDeletionFence
  excludeDesignFolder?: typeof excludeDesignFolder
}

const requestSchema = imagesConversationInputSchema.extend({ directory: z.string().min(1).max(4096) }).strict()
const unavailable = { status: "blocked", reason: "unavailable" } as const
const READ_TIMEOUT_MS = 8_000

/** Why a conversation request was refused before reaching OpenCode's answer. */
export type ImagesConversationRefusal = "denied" | "deleting"

/**
 * Finds or creates the Location's Images conversation through the fixed
 * session-pruning method (dev-docs/SESSION_PRUNING_RPC.md#images-conversation).
 * The caller supplies the title, agent and model it resolved; a found
 * conversation keeps its own. A successful `open` or `new` then excludes
 * `.codenomad/design/` through the execution host's Git; `lookup` writes nothing.
 */
export async function resolveImagesConversationAt(deps: ImagesConversationRouteDeps, workspaceId: string, directory: string,
  input: ImagesConversationInput, options: { rpcTimeoutMs?: number; signal?: AbortSignal; connection?: ServiceConnection; authorize?: () => Promise<void> } = {},
): Promise<ImagesConversationResponse | ImagesConversationRefusal> {
  const exclude = deps.excludeDesignFolder ?? excludeDesignFolder
  const manager = deps.workspaceManager
  const workspace = manager.get(workspaceId), base = manager.getServiceLocation(workspaceId)
  const deadlineAt = Date.now() + (options.rpcTimeoutMs ?? 15_000)
  const signal = AbortSignal.any([AbortSignal.timeout(options.rpcTimeoutMs ?? 15_000), ...(options.signal ? [options.signal] : [])])
  const fences = [deps.worktreeDeletionFence.captureDisplay([directory, ...(base ? [base.directory] : [])])]
  // Authorize the caller's directory before any OpenCode request: reading a
  // Location boots its services (configuration discovery, plugins).
  if (!await manager.ownsLocation(workspaceId, { directory }, undefined, { signal })) return "denied"
  const identity = await manager.getWorktreeIdentityForPath(workspaceId, directory)
  if (!identity) return "denied"
  const release = deps.worktreeDeletionFence.enter([identity])
  if (!release) return "deleting"
  fences.push(deps.worktreeDeletionFence.captureDisplay([identity]))
  // Keep custody of admitted work and the deletion fence through cancellation settlement.
  try { return await admitted() } finally { release() }

  async function admitted(): Promise<ImagesConversationResponse | ImagesConversationRefusal> {
    const connection = options.connection ?? await manager.getSharedServiceConnection(workspaceId)
    if (!connection || !workspace || !base) return unavailable
    const client = connection.client
    const current = () => {
      signal.throwIfAborted(); connection.assertCurrent()
      if (manager.get(workspaceId) !== workspace || manager.getServiceLocation(workspaceId) !== base || fences.some(check => !check())) throw new Error("Images placement changed")
    }
    const revalidate = async () => {
      current()
      if (!await manager.ownsLocation(workspaceId, { directory }, client, { signal })) throw new Error("Images ownership changed")
      current()
      await options.authorize?.()
      current()
    }
    await revalidate()
    const read = AbortSignal.timeout(READ_TIMEOUT_MS)
    const location = await client.location.get({ location: { directory } }, { signal: AbortSignal.any([read, signal]) })
      .then(readLocationRef, () => undefined)
    current()
    if (!location || location.directory !== directory || !await manager.ownsLocation(workspaceId, location, client, { signal })) return "denied"
    let result: ImagesConversationResponse
    try {
      await manager.desktopPluginsReady({ connection, location: { directory }, signal, deadlineAt, assertCurrent: current })
      await revalidate()
      current()
      const response = await client.rpc.call({ rpcID: PRUNING_RPC_ID, method: "imagesConversation", input, location: { directory } },
        { ...locationRequestOptions(location), signal })
      await revalidate()
      const output = imagesConversationResultSchema.safeParse(response.output)
      if (!output.success) return unavailable
      result = output.data
    } catch {
      signal.throwIfAborted()
      // Missing method, older plugin or timeout: no fallback and nothing created here.
      return unavailable
    }
    if (result.status !== "found" || input.mode === "lookup") return result
    await revalidate()
    current()
    const gitExclusion: GitExclusion = await exclude({
      directory, distro: manager.getServiceWslDistro(workspaceId),
      toHost: servicePath => manager.getHostPathForServicePath(workspaceId, servicePath),
    })
    await revalidate()
    current()
    return { ...result, gitExclusion }
  }
}

export function registerImagesConversationRoute(app: FastifyInstance, deps: ImagesConversationRouteDeps): void {
  app.post<{ Params: { id: string } }>("/api/workspaces/:id/images-conversation", { bodyLimit: 8192 }, async (request, reply) => {
    const parsed = requestSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "Invalid Images conversation request" })
    const { directory, ...input } = parsed.data
    const abandoned = new AbortController()
    const abort = () => { if (!reply.raw.writableEnded) abandoned.abort() }
    reply.raw.once("close", abort)
    let result
    try { result = await resolveImagesConversationAt(deps, request.params.id, directory, input, { signal: abandoned.signal }) }
    catch { return unavailable }
    finally { reply.raw.removeListener("close", abort) }
    if (result === "denied") return reply.code(403).send({ error: "Location does not belong to workspace" })
    if (result === "deleting") return reply.code(409).send({ error: "Worktree deletion is in progress" })
    return result
  })
}
