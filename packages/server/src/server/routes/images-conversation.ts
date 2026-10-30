import { z } from "zod"
import type { FastifyInstance } from "fastify"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { excludeDesignFolder } from "../../workspaces/design-git-exclude"
import { locationRequestOptions, readLocationRef } from "../../opencode/compatibility/location"
import { PRUNING_RPC_ID } from "../../opencode/session-pruning/contract"
import { imagesConversationInputSchema, imagesConversationResultSchema, type ImagesConversationInput } from "../../opencode/session-pruning/assets-gallery-contract"
import type { GitExclusion, ImagesConversationResponse } from "./images-conversation-contract"

export interface ImagesConversationRouteDeps {
  workspaceManager: Pick<WorkspaceManager, "getSharedServiceClient" | "ownsLocation" | "getWorktreeIdentityForPath" | "desktopPluginsReady"
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
  input: ImagesConversationInput, options: { rpcTimeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ImagesConversationResponse | ImagesConversationRefusal> {
  const exclude = deps.excludeDesignFolder ?? excludeDesignFolder
  const manager = deps.workspaceManager
  // Authorize the caller's directory before any OpenCode request: reading a
  // Location boots its services (configuration discovery, plugins).
  if (!await manager.ownsLocation(workspaceId, { directory }, undefined, options.signal)) return "denied"
  const identity = await manager.getWorktreeIdentityForPath(workspaceId, directory)
  if (!identity) return "denied"
  const release = deps.worktreeDeletionFence.enter([identity])
  if (!release) return "deleting"
  // An aborted caller unwinds at once, releasing the deletion fence even while a read still waits.
  try { return await untilAborted(options.signal, admitted()) } finally { release() }

  async function admitted(): Promise<ImagesConversationResponse | ImagesConversationRefusal> {
    const client = await manager.getSharedServiceClient()
    // Await plugin registration before reading the authorized Location.
    await manager.desktopPluginsReady()
    options.signal?.throwIfAborted()
    const read = AbortSignal.timeout(READ_TIMEOUT_MS)
    const location = await client.location.get({ location: { directory } }, { signal: options.signal ? AbortSignal.any([read, options.signal]) : read })
      .then(readLocationRef, () => undefined)
    options.signal?.throwIfAborted()
    if (!location || location.directory !== directory || !await manager.ownsLocation(workspaceId, location, client, options.signal)) return "denied"
    let result: ImagesConversationResponse
    try {
      const timeout = AbortSignal.timeout(options.rpcTimeoutMs ?? 15_000)
      const response = await client.rpc.call({ rpcID: PRUNING_RPC_ID, method: "imagesConversation", input, location: { directory } },
        { ...locationRequestOptions(location), signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout })
      const output = imagesConversationResultSchema.safeParse(response.output)
      if (!output.success) return unavailable
      result = output.data
    } catch {
      options.signal?.throwIfAborted()
      // Missing method, older plugin or timeout: no fallback and nothing created here.
      return unavailable
    }
    if (result.status !== "found" || input.mode === "lookup") return result
    options.signal?.throwIfAborted()
    const gitExclusion: GitExclusion = await exclude({
      directory, distro: manager.getServiceWslDistro(workspaceId),
      toHost: servicePath => manager.getHostPathForServicePath(workspaceId, servicePath),
    })
    return { ...result, gitExclusion }
  }
}

/** `work`, or a rejection as soon as `signal` aborts (without a signal, `work` itself). */
function untilAborted<T>(signal: AbortSignal | undefined, work: Promise<T>): Promise<T> {
  if (!signal) return work
  work.catch(() => {})
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

export function registerImagesConversationRoute(app: FastifyInstance, deps: ImagesConversationRouteDeps): void {
  app.post<{ Params: { id: string } }>("/api/workspaces/:id/images-conversation", { bodyLimit: 8192 }, async (request, reply) => {
    const parsed = requestSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "Invalid Images conversation request" })
    const { directory, ...input } = parsed.data
    const result = await resolveImagesConversationAt(deps, request.params.id, directory, input)
    if (result === "denied") return reply.code(403).send({ error: "Location does not belong to workspace" })
    if (result === "deleting") return reply.code(409).send({ error: "Worktree deletion is in progress" })
    return result
  })
}
