import { z } from "zod"
import type { FastifyInstance } from "fastify"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { excludeDesignFolder } from "../../workspaces/design-git-exclude"
import { locationRequestOptions, readLocationRef } from "../../opencode/compatibility/location"
import { PRUNING_RPC_ID } from "../../opencode/session-pruning/contract"
import { imagesConversationInputSchema, imagesConversationResultSchema } from "../../opencode/session-pruning/assets-gallery-contract"
import type { ImagesConversationResponse } from "./images-conversation-contract"

export interface ImagesConversationRouteDeps {
  workspaceManager: Pick<WorkspaceManager, "getSharedServiceClient" | "ownsLocation" | "getWorktreeIdentityForPath" | "desktopPluginsReady"
    | "getServiceWslDistro" | "getHostPathForServicePath">
  worktreeDeletionFence: WorktreeDeletionFence
  excludeDesignFolder?: typeof excludeDesignFolder
}

const requestSchema = imagesConversationInputSchema.extend({ directory: z.string().min(1).max(4096) }).strict()
const unavailable = { status: "blocked", reason: "unavailable" } as const

/**
 * Finds or creates the Location's Images conversation through the fixed
 * session-pruning method (dev-docs/SESSION_PRUNING_RPC.md#images-conversation).
 * The caller supplies the title, agent and model it resolved; a found
 * conversation keeps its own. A successful `open` or `new` then excludes
 * `.codenomad/design/` through the execution host's Git.
 */
export function registerImagesConversationRoute(app: FastifyInstance, deps: ImagesConversationRouteDeps): void {
  const exclude = deps.excludeDesignFolder ?? excludeDesignFolder
  app.post<{ Params: { id: string } }>("/api/workspaces/:id/images-conversation", { bodyLimit: 8192 }, async (request, reply) => {
    const parsed = requestSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "Invalid Images conversation request" })
    const { directory, ...input } = parsed.data
    const manager = deps.workspaceManager
    // Authorize the caller's directory before any OpenCode request: reading a
    // Location boots its services (configuration discovery, plugins).
    const denied = () => reply.code(403).send({ error: "Location does not belong to workspace" })
    if (!await manager.ownsLocation(request.params.id, { directory })) return denied()
    const identity = await manager.getWorktreeIdentityForPath(request.params.id, directory)
    if (!identity) return denied()
    const release = deps.worktreeDeletionFence.enter([identity])
    if (!release) return reply.code(409).send({ error: "Worktree deletion is in progress" })
    try {
      const client = await manager.getSharedServiceClient()
      // Await plugin registration before reading the authorized Location.
      await manager.desktopPluginsReady()
      const location = await client.location.get({ location: { directory } }).then(readLocationRef, () => undefined)
      if (!location || location.directory !== directory || !await manager.ownsLocation(request.params.id, location, client)) return denied()
      let result: ImagesConversationResponse
      try {
        const response = await client.rpc.call({ rpcID: PRUNING_RPC_ID, method: "imagesConversation", input, location: { directory } },
          { ...locationRequestOptions(location), signal: AbortSignal.timeout(15_000) })
        const output = imagesConversationResultSchema.safeParse(response.output)
        if (!output.success) return unavailable
        result = output.data
      } catch {
        // Missing method, older plugin or timeout: no fallback and nothing created here.
        return unavailable
      }
      if (result.status !== "found" || input.mode === "lookup") return result
      const gitExclusion = await exclude({
        directory, distro: manager.getServiceWslDistro(request.params.id),
        toHost: servicePath => manager.getHostPathForServicePath(request.params.id, servicePath),
      })
      return { ...result, gitExclusion }
    } finally { release() }
  })
}
