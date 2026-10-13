import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"
import { z } from "zod"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { PanelExtensionStore } from "../../panel-extensions/store"
import { PanelExtensionError, readPanelExtensionArchive } from "../../panel-extensions/archive"
import { PANEL_EXTENSION_LIMITS } from "../../panel-extensions/contract"
import { createPanelExtensionCatalog } from "../../panel-extensions/catalog"

const Digest = z.string().regex(/^[a-f0-9]{64}$/)
const Scope = z.object({ instanceId: z.string().min(1).max(256) }).strict()
const Archive = z.object({ archiveBase64: z.string().min(1).max(Math.ceil(PANEL_EXTENSION_LIMITS.archiveBytes / 3) * 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) })
const Id = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{1,39}\.[a-z][a-z0-9-]{1,39}$/) }).strict()

export function registerPanelExtensionRoutes(app: FastifyInstance, deps: {
  store: PanelExtensionStore; workspaceManager: Pick<WorkspaceManager, "get">; catalog?: ReturnType<typeof createPanelExtensionCatalog>
}) {
  const catalog = deps.catalog ?? createPanelExtensionCatalog()
  const Selection = Id.extend({ digest: Digest })
  const protect = (operation: (request: FastifyRequest) => Promise<unknown>) => async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store")
    try { return await operation(request) }
    catch (error) {
      const code = error instanceof PanelExtensionError ? error.code : error instanceof z.ZodError ? "invalid" : "unavailable"
      const status = { invalid: 400, conflict: 409, limit: 413, missing: 404, disabled: 403, unavailable: 503 }[code]
      return reply.code(status).send({ error: `panel-extension-${code}` })
    }
  }
  const options = { bodyLimit: Math.ceil(PANEL_EXTENSION_LIMITS.archiveBytes / 3) * 4 + 4096 }
  app.get("/api/panel-extensions/catalog", protect(async request => {
    const query = z.object({ refresh: z.literal("true").optional() }).strict().parse(request.query)
    return catalog.list(query.refresh === "true")
  }))
  app.post("/api/panel-extensions/catalog/inspect", protect(async request => {
    const { id, digest } = Selection.strict().parse(request.body)
    const pkg = await catalog.inspect(id, digest)
    return { manifest: pkg.manifest, digest: pkg.digest }
  }))
  app.post("/api/panel-extensions/catalog/install", protect(async request => {
    const body = Selection.extend({ previousDigest: Digest.optional(), acknowledged: z.literal(true) }).strict().parse(request.body)
    const pkg = await catalog.inspect(body.id, body.digest)
    await deps.store.install(pkg, body.previousDigest)
    return { installed: true }
  }))
  app.post("/api/panel-extensions/inspect", options, protect(async request => {
    const body = Archive.strict().parse(request.body)
    const { manifest, digest } = await readPanelExtensionArchive(Buffer.from(body.archiveBase64, "base64"))
    return { manifest, digest }
  }))
  app.get("/api/panel-extensions", protect(async request => {
    z.object({}).strict().parse(request.query)
    return deps.store.list()
  }))
  app.post("/api/panel-extensions", options, protect(async request => {
    const body = Archive.extend({ digest: Digest, previousDigest: Digest.optional(), acknowledged: z.literal(true) }).strict().parse(request.body)
    const pkg = await readPanelExtensionArchive(Buffer.from(body.archiveBase64, "base64"))
    if (pkg.digest !== body.digest) throw new PanelExtensionError("conflict")
    await deps.store.install(pkg, body.previousDigest)
    return { installed: true }
  }))
  app.patch("/api/panel-extensions/:id", protect(async request => {
    z.object({}).strict().parse(request.query)
    const { id } = Id.parse(request.params)
    const body = z.object({ digest: Digest, enabled: z.boolean() }).strict().parse(request.body)
    await deps.store.activate(id, body.digest, body.enabled)
    return { updated: true }
  }))
  app.delete("/api/panel-extensions/:id", protect(async request => {
    const { id } = Id.parse(request.params)
    const { digest } = z.object({ digest: Digest }).strict().parse(request.body)
    await deps.store.remove(id, digest)
    return { removed: true }
  }))
  app.get("/api/panel-extensions/:id/panel", protect(async request => {
    const query = Scope.extend({ digest: Digest }).parse(request.query)
    const { id } = Id.parse(request.params)
    const workspace = deps.workspaceManager.get(query.instanceId)
    if (!workspace) throw new PanelExtensionError("missing")
    return { html: await deps.store.panel(id, query.digest) }
  }))
}
