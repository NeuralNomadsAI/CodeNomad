import { z } from "zod"
import type { FastifyInstance } from "fastify"
import type { OpenCodeClient } from "@opencode/client"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { PanelExtensionStore } from "../../panel-extensions/store"
import type { PanelExtensionPermission, PanelConversationStatus } from "../../panel-extensions/contract"
import { PanelExtensionError } from "../../panel-extensions/archive"
import { readPanelImagesStatus } from "../../panel-extensions/images-status"
import type { ImageSettings } from "../../opencode/image-settings"
import { PRUNING_RPC_ID } from "../../opencode/session-pruning/contract"
import { assetTargetSchema } from "../../opencode/session-pruning/assets-contract"
import { generationTargetSchema, imageReadResultSchema, imageReferenceResultSchema, imagesConversationInputSchema,
  imagesResultSchema } from "../../opencode/session-pruning/assets-gallery-contract"
import { locationRequestOptions, readLocationRef } from "../../opencode/compatibility/location"
import { resolveImagesConversationAt, type ImagesConversationRouteDeps } from "./images-conversation"
import { checkDesignFolderExclusion } from "../../workspaces/design-git-exclude"

const Id = z.string().min(1).max(256)
const authority = { instanceId: Id, digest: z.string().regex(/^[a-f0-9]{64}$/) }
const idSchema = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{1,39}\.[a-z][a-z0-9-]{1,39}$/) }).strict()
const Directory = z.string().min(1).max(4096)
// Server work ends before the frame's 19.5 s deadline; each daemon read gets a shorter share.
const ROUTE_BUDGET_MS = 19_000, RPC_TIMEOUT_MS = 8_000

export interface PanelExtensionApi4Deps extends ImagesConversationRouteDeps {
  store: PanelExtensionStore
  workspaceManager: ImagesConversationRouteDeps["workspaceManager"] & Pick<WorkspaceManager, "getSharedServiceConnection" | "get">
  imageSettings: Pick<ImageSettings, "read">
  checkDesignFolderExclusion?: typeof checkDesignFolderExclusion
}

class Refused extends Error { constructor(readonly status: number) { super("refused") } }

/**
 * API 4 capabilities (dev-docs/PANEL_EXTENSIONS.md#api-4): one fixed route per
 * method, each checking its own permission on the enabled exact package before
 * and after IO. The host chooses instance, session and Location; addons supply
 * only cursors, targets and preferences.
 */
export function registerPanelExtensionApi4Routes(app: FastifyInstance, deps: PanelExtensionApi4Deps) {
  const manager = deps.workspaceManager
  const checkExclusion = deps.checkDesignFolderExclusion ?? checkDesignFolderExclusion
  const route = <T extends z.ZodRawShape>(method: string, permission: PanelExtensionPermission | null, shape: T, bodyLimit: number,
    run: (input: z.infer<z.ZodObject<T & typeof authority>>, context: { id: string; signal: AbortSignal; prompts: boolean }) => Promise<unknown>) => {
    const schema = z.object({ ...authority, ...shape }).strict()
    app.post(`/api/panel-extensions/:id/${method}`, { bodyLimit }, async (request, reply) => {
      reply.header("Cache-Control", "no-store")
      // A caller that goes away (unmounted panel, frame deadline) cancels the server work.
      const abandoned = new AbortController()
      reply.raw.once("close", () => { if (!reply.raw.writableFinished) abandoned.abort(new Error("Request abandoned")) })
      const signal = AbortSignal.any([abandoned.signal, AbortSignal.timeout(ROUTE_BUDGET_MS)])
      try {
        const { id } = idSchema.parse(request.params)
        const input = schema.parse(request.body) as z.infer<z.ZodObject<T & typeof authority>> & { instanceId: string; digest: string }
        const entry = permission ? await deps.store.authorize(id, input.digest, permission) : undefined
        const prompts = Boolean(entry && (entry.manifest.permissions as readonly string[]).includes("session.images.prompts"))
        const result = await run(input, { id, signal, prompts })
        // Revocation or replacement during IO fences the result.
        if (permission) await deps.store.authorize(id, input.digest, permission)
        signal.throwIfAborted()
        return result
      } catch (error) {
        const code = error instanceof Refused ? error.status : error instanceof z.ZodError ? 400 : error instanceof PanelExtensionError
          ? { missing: 404, disabled: 403, conflict: 409, invalid: 400, limit: 413, unavailable: 503 }[error.code] : 503
        return reply.code(code).send({ error: "Panel extension request unavailable" })
      }
    })
  }

  const connect = async (instanceId: string) => {
    const connection = await manager.getSharedServiceConnection(instanceId)
    if (!connection) throw new PanelExtensionError("unavailable")
    connection.assertCurrent()
    return connection
  }
  /** The owned session's Location, read again after IO by `fenced`. */
  const ownedSession = async (instanceId: string, client: OpenCodeClient, sessionID: string) => {
    const session = await client.session.get({ sessionID })
    if (!await manager.ownsLocation(instanceId, session.location, client)) throw new Refused(403)
    return session
  }
  const sessionRpc = async (instanceId: string, sessionID: string, method: string, input: Record<string, any>, signal: AbortSignal) => {
    const connection = await connect(instanceId)
    const client = connection.client
    const location = readLocationRef((await ownedSession(instanceId, client, sessionID)).location)
    await manager.desktopPluginsReady()
    connection.assertCurrent()
    const result = await client.rpc.call({ rpcID: PRUNING_RPC_ID, method, input, location: { directory: location.directory } },
      { ...locationRequestOptions(location), signal: AbortSignal.any([signal, AbortSignal.timeout(RPC_TIMEOUT_MS)]) })
    connection.assertCurrent()
    // Moves during IO fence the response too.
    const current = readLocationRef((await ownedSession(instanceId, client, sessionID)).location)
    if (JSON.stringify(current) !== JSON.stringify(location)) throw new Refused(409)
    return result.output
  }
  const parsed = <S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> => {
    const result = schema.safeParse(value)
    if (!result.success) throw new PanelExtensionError("unavailable")
    return result.data
  }

  // session.images.read
  route("images", "session.images.read", { sessionID: Id, cursor: z.string().max(4096).optional() }, 8192, async (input, { signal, prompts }) =>
    parsed(imagesResultSchema, await sessionRpc(input.instanceId, input.sessionID, "images",
      { sessionID: input.sessionID, ...(input.cursor ? { cursor: input.cursor } : {}), prompts }, signal)))
  route("imageRead", "session.images.read", { sessionID: Id, target: assetTargetSchema }, 8192, async (input, { signal }) =>
    parsed(imageReadResultSchema, await sessionRpc(input.instanceId, input.sessionID, "imageRead", { sessionID: input.sessionID, target: input.target }, signal)))
  route("imagesStatus", "session.images.read", { sessionID: Id.optional(), directory: Directory.optional() }, 8192, async input => {
    const connection = await connect(input.instanceId)
    const session = input.sessionID ? await ownedSession(input.instanceId, connection.client, input.sessionID) : undefined
    const location = session ? readLocationRef(session.location) : input.directory ? { directory: input.directory } : undefined
    if (!location || !await manager.ownsLocation(input.instanceId, location, connection.client)) throw new Refused(403)
    const status = await readPanelImagesStatus({ imageSettings: deps.imageSettings, client: connection.client }, input.instanceId, location, session)
    connection.assertCurrent()
    return status
  })

  // composer.prefill: every reference is revalidated now, never substituted.
  route("prefillReferences", "composer.prefill", { sessionID: Id, targets: z.array(z.union([assetTargetSchema, generationTargetSchema])).min(1).max(16) }, 16384,
    async (input, { signal }) => {
      const paths: Array<string | null> = []
      for (const target of input.targets) {
        const result = parsed(imageReferenceResultSchema, await sessionRpc(input.instanceId, input.sessionID, "imageReference",
          { sessionID: input.sessionID, target }, signal))
        if (result.status === "blocked") throw new PanelExtensionError("unavailable")
        paths.push(result.status === "path" ? result.path : null)
      }
      return { paths }
    })

  // images.conversation: the host resolves the Location, title, agent and model.
  route("conversationStatus", "images.conversation", { directory: Directory, sessionID: Id.optional() }, 8192, async (input, { signal }) => {
    const connection = await connect(input.instanceId)
    const displayed = input.sessionID ? await ownedSession(input.instanceId, connection.client, input.sessionID) : undefined
    const found = await resolveImagesConversationAt(deps, input.instanceId, input.directory, { mode: "lookup" }, { rpcTimeoutMs: RPC_TIMEOUT_MS, signal })
    if (found === "denied") throw new Refused(403)
    if (found === "deleting") throw new PanelExtensionError("unavailable")
    const status: PanelConversationStatus = { lookup: found.status === "found" ? "found" : found.status === "absent" ? "absent" : "unknown",
      imageCount: null, lastUsed: null, gitExclusion: null,
      displayedIsImages: Boolean(displayed && !displayed.parentID && (displayed.metadata as Record<string, unknown> | undefined)?.["codenomad.companion"] === "images") }
    if (found.status !== "found") return status
    // Status never writes: the exclusion is only checked; open and startNew append it.
    const [session, page, gitExclusion] = await Promise.all([
      connection.client.session.get({ sessionID: found.sessionID }).catch(() => undefined),
      sessionRpc(input.instanceId, found.sessionID, "images", { sessionID: found.sessionID }, signal).catch(() => undefined),
      checkExclusion({ directory: input.directory, distro: manager.getServiceWslDistro(input.instanceId),
        toHost: servicePath => manager.getHostPathForServicePath(input.instanceId, servicePath) }),
    ])
    const images = imagesResultSchema.safeParse(page)
    status.lastUsed = typeof session?.time?.updated === "number" ? session.time.updated : null
    // Exact only when the whole gallery fits the one page read; otherwise unknown, never a partial total.
    status.imageCount = images.success && images.data.status === "page" && images.data.cursor === null
      ? images.data.entries.filter(entry => entry.kind === "image").length : null
    status.gitExclusion = gitExclusion
    return status
  })
  const resolve = z.object({ directory: Directory, title: z.string().min(1).max(256), agent: z.string().min(1).max(256).optional(),
    model: imagesConversationInputSchema.shape.model })
  for (const [method, mode] of [["conversationOpen", "open"], ["conversationNew", "new"]] as const) {
    route(method, "images.conversation", resolve.shape, 8192, async (input, { signal }) => {
      const { instanceId: _instance, digest: _digest, directory, ...options } = input
      const result = await resolveImagesConversationAt(deps, input.instanceId, directory, { mode, ...options }, { rpcTimeoutMs: RPC_TIMEOUT_MS, signal })
      if (result === "denied") throw new Refused(403)
      if (result === "deleting") throw new PanelExtensionError("unavailable")
      return result
    })
  }

  // panel.preferences: profile-wide, so the instance only proves an open window. The store
  // checks the grant itself; a corrupt store or another authority answers `unavailable`.
  const preferences = async <T>(read: () => Promise<T>) => {
    try { return await read() } catch (error) {
      if (error instanceof PanelExtensionError && error.code === "unavailable") return { status: "unavailable" } as const
      throw error
    }
  }
  route("preferencesGet", null, {}, 4096, async (input, { id }) => {
    if (!manager.get(input.instanceId)) throw new PanelExtensionError("missing")
    return preferences(async () => ({ status: "ok" as const, value: await deps.store.preferences(id, input.digest) }))
  })
  route("preferencesSet", null, { value: z.unknown() }, 16384, async (input, { id }) => {
    if (!manager.get(input.instanceId)) throw new PanelExtensionError("missing")
    return preferences(async () => ({ status: await deps.store.setPreferences(id, input.digest, input.value) }))
  })
}
