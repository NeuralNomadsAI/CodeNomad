import { z } from "zod"
import type { FastifyInstance } from "fastify"
import { isSessionNotFoundError, type LocationRef, type OpenCodeClient } from "@opencode/client"
import type { WorkspaceManager } from "../../workspaces/manager"
import { noteTitle, type PanelExtensionStore, type PanelStoredNote } from "../../panel-extensions/store"
import { PANEL_EXTENSION_LIMITS, type PanelExtensionPermission, type PanelConversationStatus, type PanelNotesPage } from "../../panel-extensions/contract"
import { resolveMemoryProjectIdentity } from "../../memory/project-identity"
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
import { captureDisplayIdentities } from "../../workspaces/worktree-display-identity"
import type { ServiceConnection } from "../../workspaces/opencode-service"

const Id = z.string().min(1).max(256)
const authority = { instanceId: Id, digest: z.string().regex(/^[a-f0-9]{64}$/) }
const idSchema = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{1,39}\.[a-z][a-z0-9-]{1,39}$/) }).strict()
const Directory = z.string().min(1).max(4096)
// Server work ends before the frame's 19.5 s deadline; each daemon read gets a shorter share.
const ROUTE_BUDGET_MS = 19_000, RPC_TIMEOUT_MS = 8_000

export interface PanelExtensionApi4Deps extends ImagesConversationRouteDeps {
  store: PanelExtensionStore
  workspaceManager: ImagesConversationRouteDeps["workspaceManager"] & Pick<WorkspaceManager, "getSharedServiceConnection" | "get" | "getServiceDirectoryForPath" | "list">
  imageSettings: Pick<ImageSettings, "read">
  checkDesignFolderExclusion?: typeof checkDesignFolderExclusion
  /** Tests only: the agent-memory project identity that files `panel.notes`. */
  projectIdentity?: typeof resolveMemoryProjectIdentity
  /** Tests only: the whole-route deadline. */
  routeBudgetMs?: number
}

class Refused extends Error { constructor(readonly status: number) { super("refused") } }

interface RouteContext {
  id: string
  signal: AbortSignal
  prompts: boolean
  authorize(): Promise<void>
  /** A check run once, after every read, before the answer (keyed so repeated reads of one session check once). */
  fence(key: string, check: () => Promise<void>): void
  /** A connection the answer was read through, asserted current right before it is sent. */
  pin(connection: { assertCurrent(): void }): void
  /** A write committed after its own checks: its answer is sent as is, never refused by reads after it. */
  committed(): void
  /** The commit has started: from now on its own outcome, not the deadline or the caller's departure, settles the route. */
  committing(): void
}

/** `work`, or a rejection as soon as `signal` aborts (unless `committing`); a late outcome is dropped. */
function settle<T>(signal: AbortSignal, work: () => Promise<T>, committing: () => boolean = () => false): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = () => { if (!committing()) reject(signal.reason) }
    signal.addEventListener("abort", abort, { once: true })
    work().then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

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
    run: (input: z.infer<z.ZodObject<T & typeof authority>>, context: RouteContext) => Promise<unknown>) => {
    const schema = z.object({ ...authority, ...shape }).strict()
    app.post(`/api/panel-extensions/:id/${method}`, { bodyLimit }, async (request, reply) => {
      reply.header("Cache-Control", "no-store")
      // A caller that goes away (unmounted panel, frame deadline) cancels the server work.
      const abandoned = new AbortController()
      reply.raw.once("close", () => { if (!reply.raw.writableFinished) abandoned.abort(new Error("Request abandoned")) })
      const signal = AbortSignal.any([abandoned.signal, AbortSignal.timeout(deps.routeBudgetMs ?? ROUTE_BUDGET_MS)])
      try {
        const { id } = idSchema.parse(request.params)
        const input = schema.parse(request.body) as z.infer<z.ZodObject<T & typeof authority>> & { instanceId: string; digest: string }
        const workspace = manager.get(input.instanceId), base = manager.getServiceLocation(input.instanceId)
        const display = deps.worktreeDeletionFence.captureDisplay(base ? [base.directory] : [])
        const placement = { assertCurrent() {
          if (!workspace || !base || manager.get(input.instanceId) !== workspace || manager.getServiceLocation(input.instanceId) !== base || !display()) throw new Refused(409)
        } }
        // The route settles on the deadline or the caller's departure, whatever its reads still await.
        let started = false
        return await settle(signal, async () => {
          const entry = permission ? await deps.store.authorize(id, input.digest, permission) : undefined
          const prompts = Boolean(entry && (entry.manifest.permissions as readonly string[]).includes("session.images.prompts"))
          const fences = new Map<string, () => Promise<void>>(), pinned = new Set<{ assertCurrent(): void }>()
          if (permission) { placement.assertCurrent(); pinned.add(placement) }
          signal.throwIfAborted()
          const authorize = async () => {
            signal.throwIfAborted()
            if (permission) await deps.store.authorize(id, input.digest, permission)
            signal.throwIfAborted()
            for (const connection of pinned) connection.assertCurrent()
          }
          let written = false
          const result = await run(input, { id, signal, prompts, authorize, fence: (key, check) => { if (!fences.has(key)) fences.set(key, check) },
            pin: connection => { pinned.add(connection) }, committed: () => { written = true }, committing: () => { started = true } })
          if (written) return result
          // After the last read: Location and session ownership, then consent, then (synchronously,
          // with nothing awaited before the answer) every connection the answer was read through.
          for (const check of fences.values()) { signal.throwIfAborted(); await check() }
          if (permission) await deps.store.authorize(id, input.digest, permission)
          signal.throwIfAborted()
          for (const connection of pinned) connection.assertCurrent()
          return result
        }, () => started)
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
  const bounded = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(RPC_TIMEOUT_MS)])
  /** The session, when its Location belongs to the workspace. */
  const ownedSession = async (instanceId: string, client: OpenCodeClient, sessionID: string, signal: AbortSignal) => {
    const session = await client.session.get({ sessionID }, { signal: bounded(signal) })
    signal.throwIfAborted()
    if (!await manager.ownsLocation(instanceId, session.location, client, { signal })) throw new Refused(403)
    signal.throwIfAborted()
    return session
  }
  /** Fences the answer on the session still being owned at the same Location after every read. */
  const fenceSession = (context: RouteContext, instanceId: string, client: OpenCodeClient, sessionID: string, location: LocationRef) =>
    context.fence(`session:${sessionID}`, async () => {
      const current = readLocationRef((await ownedSession(instanceId, client, sessionID, context.signal)).location)
      if (JSON.stringify(current) !== JSON.stringify(readLocationRef(location))) throw new Refused(409)
    })
  const fenceLocation = (context: RouteContext, instanceId: string, client: OpenCodeClient, directory: string) =>
    context.fence(`location:${directory}`, async () => {
      if (!await manager.ownsLocation(instanceId, { directory }, client, { signal: context.signal })) throw new Refused(403)
    })
  const sessionRpc = async (context: RouteContext, instanceId: string, sessionID: string, method: string, input: Record<string, any>, captured?: ServiceConnection) => {
    const workspace = manager.get(instanceId), base = manager.getServiceLocation(instanceId)
    const fences = [deps.worktreeDeletionFence.captureDisplay(base ? [base.directory] : [])]
    const signal = bounded(context.signal), deadlineAt = Date.now() + RPC_TIMEOUT_MS
    const connection = captured ?? await connect(instanceId)
    const client = connection.client
    context.pin(connection)
    const current = () => {
      signal.throwIfAborted(); connection.assertCurrent()
      if (!workspace || !base || manager.get(instanceId) !== workspace || manager.getServiceLocation(instanceId) !== base || fences.some(check => !check())) throw new Refused(409)
    }
    current()
    const location = readLocationRef((await ownedSession(instanceId, client, sessionID, signal)).location)
    current()
    fences.push((await captureDisplayIdentities(deps.worktreeDeletionFence, manager, instanceId, [location.directory]))!)
    current()
    const revalidate = async () => {
      current()
      const latest = await ownedSession(instanceId, client, sessionID, signal)
      current()
      if (JSON.stringify(readLocationRef(latest.location)) !== JSON.stringify(location)) throw new Refused(409)
      await context.authorize()
      current()
    }
    await manager.desktopPluginsReady({ connection, location: { directory: location.directory }, signal, deadlineAt, assertCurrent: current })
    await revalidate()
    current()
    const result = await client.rpc.call({ rpcID: PRUNING_RPC_ID, method, input, location: { directory: location.directory } },
      { ...locationRequestOptions(location), signal })
    await revalidate()
    current()
    // Moves during IO fence the response too.
    fenceSession(context, instanceId, client, sessionID, location)
    return result.output
  }
  const parsed = <S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> => {
    const result = schema.safeParse(value)
    if (!result.success) throw new PanelExtensionError("unavailable")
    return result.data
  }

  // session.images.read
  route("images", "session.images.read", { sessionID: Id, cursor: z.string().max(4096).optional() }, 8192, async (input, context) =>
    parsed(imagesResultSchema, await sessionRpc(context, input.instanceId, input.sessionID, "images",
      { sessionID: input.sessionID, ...(input.cursor ? { cursor: input.cursor } : {}), prompts: context.prompts })))
  route("imageRead", "session.images.read", { sessionID: Id, target: assetTargetSchema }, 8192, async (input, context) =>
    parsed(imageReadResultSchema, await sessionRpc(context, input.instanceId, input.sessionID, "imageRead", { sessionID: input.sessionID, target: input.target })))
  route("imagesStatus", "session.images.read", { sessionID: Id.optional(), directory: Directory.optional() }, 8192, async (input, context) => {
    const connection = await connect(input.instanceId)
    context.pin(connection)
    const client = connection.client
    const session = input.sessionID ? await ownedSession(input.instanceId, client, input.sessionID, context.signal) : undefined
    const location = session ? readLocationRef(session.location) : input.directory ? { directory: input.directory } : undefined
    if (!location || !await manager.ownsLocation(input.instanceId, location, client, { signal: context.signal })) throw new Refused(403)
    if (input.sessionID) fenceSession(context, input.instanceId, client, input.sessionID, location)
    else fenceLocation(context, input.instanceId, client, location.directory)
    return readPanelImagesStatus({ imageSettings: deps.imageSettings, client }, input.instanceId, location, session, bounded(context.signal))
  })

  // composer.prefill: every reference is revalidated now, never substituted.
  route("prefillReferences", "composer.prefill", { sessionID: Id, targets: z.array(z.union([assetTargetSchema, generationTargetSchema])).min(1).max(16) }, 16384,
    async (input, context) => {
      const paths: Array<string | null> = []
      for (const target of input.targets) {
        const result = parsed(imageReferenceResultSchema, await sessionRpc(context, input.instanceId, input.sessionID, "imageReference",
          { sessionID: input.sessionID, target }))
        if (result.status === "blocked") throw new PanelExtensionError("unavailable")
        paths.push(result.status === "path" ? result.path : null)
      }
      return { paths }
    })

  // images.conversation: the host resolves the Location, title, agent and model.
  route("conversationStatus", "images.conversation", { directory: Directory, sessionID: Id.optional() }, 8192, async (input, context) => {
    const { signal } = context
    const connection = await connect(input.instanceId)
    context.pin(connection)
    const displayed = input.sessionID ? await ownedSession(input.instanceId, connection.client, input.sessionID, signal) : undefined
    if (displayed) fenceSession(context, input.instanceId, connection.client, input.sessionID!, displayed.location)
    fenceLocation(context, input.instanceId, connection.client, input.directory)
    const found = await resolveImagesConversationAt(deps, input.instanceId, input.directory, { mode: "lookup" }, { rpcTimeoutMs: RPC_TIMEOUT_MS, signal, connection, authorize: context.authorize })
    if (found === "denied") throw new Refused(403)
    if (found === "deleting") throw new PanelExtensionError("unavailable")
    const status: PanelConversationStatus = { lookup: found.status === "found" ? "found" : found.status === "absent" ? "absent" : "unknown",
      imageCount: null, lastUsed: null, gitExclusion: null,
      displayedIsImages: Boolean(displayed && !displayed.parentID && (displayed.metadata as Record<string, unknown> | undefined)?.["codenomad.companion"] === "images") }
    if (found.status !== "found") return status
    // The found conversation must be owned at this Location; its fence holds the answer.
    const session = await ownedSession(input.instanceId, connection.client, found.sessionID, signal)
    if (readLocationRef(session.location).directory !== input.directory) throw new Refused(409)
    fenceSession(context, input.instanceId, connection.client, found.sessionID, session.location)
    // Status never writes: the exclusion is only checked; open and startNew append it. An
    // unreadable gallery only leaves the count unknown; an authority refusal fails the request.
    const [page, gitExclusion] = await Promise.all([
      sessionRpc(context, input.instanceId, found.sessionID, "images", { sessionID: found.sessionID }, connection).catch(error => {
        if (error instanceof Refused || signal.aborted) throw error
        return undefined
      }),
      checkExclusion({ directory: input.directory, distro: manager.getServiceWslDistro(input.instanceId),
        toHost: servicePath => manager.getHostPathForServicePath(input.instanceId, servicePath) }),
    ])
    const images = imagesResultSchema.safeParse(page)
    status.lastUsed = typeof session.time?.updated === "number" ? session.time.updated : null
    // Exact only when the whole gallery fits the one page read; otherwise unknown, never a partial total.
    status.imageCount = images.success && images.data.status === "page" && images.data.cursor === null
      ? images.data.entries.filter(entry => entry.kind === "image").length : null
    status.gitExclusion = gitExclusion
    return status
  })
  const resolve = z.object({ directory: Directory, title: z.string().min(1).max(256), agent: z.string().min(1).max(256).optional(),
    model: imagesConversationInputSchema.shape.model })
  for (const [method, mode] of [["conversationOpen", "open"], ["conversationNew", "new"]] as const) {
    route(method, "images.conversation", resolve.shape, 8192, async (input, context) => {
      const { instanceId: _instance, digest: _digest, directory, ...options } = input
      const connection = await connect(input.instanceId)
      context.pin(connection)
      fenceLocation(context, input.instanceId, connection.client, directory)
      const result = await resolveImagesConversationAt(deps, input.instanceId, directory, { mode, ...options },
        { rpcTimeoutMs: RPC_TIMEOUT_MS, signal: context.signal, connection, authorize: context.authorize })
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

  // panel.notes: one note per session, filed under the agent-memory project identity of the
  // displayed conversation's Location (else the instance's): worktrees share them, clones when their remote normalizes alike.
  const projectIdentity = deps.projectIdentity ?? resolveMemoryProjectIdentity
  /**
   * Per request: the project identity of a directory this instance owns, or (`anyWindow`, for
   * titles only) another open window does, as agent memory resolves a session's project; else `undefined`.
   */
  const identities = (instanceId: string) => {
    type Owner = { directory: string; distro?: string }
    const owners = new Map<string, Promise<Owner | undefined>>(), ids = new Map<string, Promise<string>>()
    const memo = <T>(cache: Map<string, Promise<T>>, key: string, read: () => Promise<T>) => {
      let found = cache.get(key)
      if (!found) { found = read(); cache.set(key, found) }
      return found
    }
    const target = async (workspaceId: string, directory: string): Promise<Owner> => {
      const owned = await manager.getServiceDirectoryForPath(workspaceId, directory)
      if (!owned) throw new Error("Not an owner")
      return { directory: owned, distro: manager.getServiceWslDistro(workspaceId) }
    }
    return async (directory: string, anyWindow = false) => {
      const own = await memo(owners, `own:${directory}`, () => target(instanceId, directory).catch(() => undefined))
      const owner = own ?? (anyWindow ? await memo(owners, `any:${directory}`, () => Promise.any(manager.list()
        .filter(workspace => workspace.id !== instanceId).map(workspace => target(workspace.id, directory))).catch(() => undefined)) : undefined)
      return owner ? memo(ids, `${owner.distro ?? ""}:${owner.directory}`, async () => (await projectIdentity(owner)).id) : undefined
    }
  }
  /** The request's project; a `write` checks its anchor inside the store queue instead of after the answer. */
  const project = async (context: RouteContext, instanceId: string, sessionID: string | undefined, write = false) => {
    const connection = await connect(instanceId)
    context.pin(connection)
    const client = connection.client
    const session = sessionID ? await ownedSession(instanceId, client, sessionID, context.signal) : undefined
    const location = session ? readLocationRef(session.location) : manager.getServiceLocation(instanceId)
    if (!location) throw new Refused(403)
    if (!write && session) fenceSession(context, instanceId, client, sessionID!, session.location)
    else if (!write) fenceLocation(context, instanceId, client, location.directory)
    // A worktree being deleted (the instance's or a linked one) refuses the answer and any write.
    const display = await captureDisplayIdentities(deps.worktreeDeletionFence, manager, instanceId, [location.directory])
    const displayed = () => { if (display && !display()) throw new Refused(409) }
    if (!write) context.fence(`display:${location.directory}`, async () => displayed())
    const identityAt = identities(instanceId)
    const id = await identityAt(location.directory)
    if (!id) throw new Refused(403)
    // Read again, uncached, after the last read: a remote change moves the project without moving the session.
    const sameProject = (directory: string) => async () => { if (await identities(instanceId)(directory) !== id) throw new Refused(409) }
    if (!write) context.fence(`identity:${location.directory}`, sameProject(location.directory))
    context.signal.throwIfAborted()
    // Inside the store queue: the anchor still where it was, then, once the bytes are staged, nothing gone stale.
    const workspace = manager.get(instanceId), base = manager.getServiceLocation(instanceId)
    // Synchronous, right before the rename; passing it starts the commit.
    const final = () => {
      context.signal.throwIfAborted(); connection.assertCurrent(); displayed()
      if (manager.get(instanceId) !== workspace || manager.getServiceLocation(instanceId) !== base) throw new Refused(409)
      context.committing()
    }
    // The slow Git identity first, then the session (or Location ownership) as close to the commit as possible.
    const check = async () => {
      await sameProject(location.directory)()
      if (session) {
        const latest = readLocationRef((await ownedSession(instanceId, client, sessionID!, context.signal)).location)
        if (JSON.stringify(latest) !== JSON.stringify(location)) throw new Refused(409)
      } else if (!await manager.ownsLocation(instanceId, { directory: location.directory }, client, { signal: context.signal })) throw new Refused(403)
      context.signal.throwIfAborted(); connection.assertCurrent(); displayed()
    }
    return { id, client, session, guard: { check, final }, identityAt, sameProject }
  }
  /** The session, or `undefined` once it is deleted; any other failure fails the request. */
  const unlessDeleted = <T>(signal: AbortSignal, read: Promise<T>) => read.catch(error => {
    if (!signal.aborted && isSessionNotFoundError(error)) return undefined
    throw error
  })
  const Revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
  const noteOf = (note?: PanelStoredNote) => note ? { text: note.text, revision: note.revision } : null
  route("notesGet", "panel.notes", { sessionID: Id }, 8192, async (input, context) => {
    const { id: projectId } = await project(context, input.instanceId, input.sessionID)
    return { note: noteOf((await deps.store.notes(context.id, input.digest, projectId)).find(note => note.sessionID === input.sessionID)) }
  })
  // JSON escapes can grow the text sixfold: the body limit bounds it, the store's UTF-8 measure answers `too-large`.
  route("notesSet", "panel.notes", { sessionID: Id, text: z.string(), revision: Revision },
    6 * PANEL_EXTENSION_LIMITS.noteBytes + 8192, async (input, context) => {
      const { id: projectId, session, guard } = await project(context, input.instanceId, input.sessionID, true)
      await context.authorize()
      const result = await deps.store.setNote(context.id, input.digest, projectId, input.sessionID, input.revision, { title: session!.title ?? "", text: input.text }, guard)
      if (result.status === "saved") context.committed()
      return result
    })
  // A live title only for a session still in this project; a moved one keeps its last written title.
  route("notesList", "panel.notes", { sessionID: Id.optional(), cursor: z.string().regex(/^\d{1,4}$/).optional() }, 8192, async (input, context) => {
    const { id: projectId, client, identityAt } = await project(context, input.instanceId, input.sessionID)
    const all = await deps.store.notes(context.id, input.digest, projectId)
    const start = Number(input.cursor ?? 0), page = all.slice(start, start + PANEL_EXTENSION_LIMITS.notesPage)
    const notes = await Promise.all(page.map(async note => {
      const live = await unlessDeleted(context.signal, client.session.get({ sessionID: note.sessionID }, { signal: bounded(context.signal) }))
      const here = live && await identityAt(readLocationRef(live.location).directory, true).catch(() => undefined) === projectId
      return { sessionID: note.sessionID, title: (here && live.title && noteTitle(live.title)) || note.title, text: note.text, revision: note.revision, updated: note.updated, orphan: !live }
    }))
    return { notes, cursor: start + page.length < all.length ? String(start + page.length) : null } satisfies PanelNotesPage
  })
  route("notesDelete", "panel.notes", { sessionID: Id.optional(), target: Id, revision: Revision.min(1) }, 8192, async (input, context) => {
    const { id: projectId, guard } = await project(context, input.instanceId, input.sessionID, true)
    await context.authorize()
    const result = await deps.store.setNote(context.id, input.digest, projectId, input.target, input.revision, { title: "", text: "" }, guard)
    if (result.status === "saved") context.committed()
    return { status: result.status === "saved" ? "deleted" as const : "conflict" as const }
  })
  // Only a session with a note in this project, owned by this instance and still in the project, may be shown.
  route("notesOpen", "panel.notes", { sessionID: Id.optional(), target: Id }, 8192, async (input, context) => {
    const { id: projectId, client, identityAt, sameProject } = await project(context, input.instanceId, input.sessionID)
    if (!(await deps.store.notes(context.id, input.digest, projectId)).some(note => note.sessionID === input.target)) return { openable: false }
    const session = await unlessDeleted(context.signal, ownedSession(input.instanceId, client, input.target, context.signal))
      .catch(error => { if (error instanceof Refused && error.status === 403) return undefined; throw error })
    if (!session || await identityAt(readLocationRef(session.location).directory) !== projectId) return { openable: false }
    const directory = readLocationRef(session.location).directory
    // The target's worktree too: a session whose worktree is being deleted is never shown.
    const display = await captureDisplayIdentities(deps.worktreeDeletionFence, manager, input.instanceId, [directory])
    if (display && !display()) return { openable: false }
    fenceSession(context, input.instanceId, client, input.target, session.location)
    context.fence(`identity:${directory}`, sameProject(directory))
    context.fence(`display:${directory}`, async () => { if (display && !display()) throw new Refused(409) })
    return { openable: true }
  })
}
