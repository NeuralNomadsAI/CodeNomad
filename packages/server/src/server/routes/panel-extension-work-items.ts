import { z } from "zod"
import type { FastifyInstance } from "fastify"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { PanelExtensionStore } from "../../panel-extensions/store"
import { PanelExtensionError } from "../../panel-extensions/archive"
import { FORGE_MAX_PAGE, type ForgeWorkItems } from "../../forge/work-items"
import { createWorkItemBranch, readWorkItemBranches } from "../../forge/work-item-branches"
import type { PanelExtensionPermission } from "../../panel-extensions/contract"

const kind = z.enum(["issue", "pullRequest"])
const authority = { instanceId: z.string().min(1).max(256), digest: z.string().regex(/^[a-f0-9]{64}$/) }
const idSchema = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{1,39}\.[a-z][a-z0-9-]{1,39}$/) }).strict()
const listSchema = z.object({ ...authority, kind, query: z.string().max(200), page: z.number().int().min(1).max(FORGE_MAX_PAGE), fresh: z.boolean() }).strict()
const urlSchema = z.object({ ...authority, kind, number: z.number().int().min(1).max(999_999_999) }).strict()

/**
 * `repository.workItems.read` (API 3, and API 4 alongside the worktree permissions below): bounded issue and pull request pages of
 * the project's forge repository, and their web pages. The host owns the
 * project folder, remote and credentials; addons only choose kind, query, page
 * or number. Consent is checked before and after each read.
 */
export function registerPanelExtensionWorkItemRoutes(app: FastifyInstance, deps: {
  store: PanelExtensionStore; workspaceManager: Pick<WorkspaceManager, "get">; forge: ForgeWorkItems
}) {
  const route = <T extends z.ZodType<{ instanceId: string; digest: string }>>(method: string, permission: PanelExtensionPermission, schema: T,
    read: (directory: string, input: z.infer<T>, signal: AbortSignal) => Promise<unknown>) => {
    app.post(`/api/panel-extensions/:id/${method}`, { bodyLimit: 4096 }, async (request, reply) => {
      reply.header("Cache-Control", "no-store")
      // A caller that goes away (unmounted panel, lost transport) abandons its read.
      const abandoned = new AbortController()
      reply.raw.once("close", () => { if (!reply.raw.writableFinished) abandoned.abort(new Error("Request abandoned")) })
      try {
        const { id } = idSchema.parse(request.params)
        const input = schema.parse(request.body)
        await deps.store.authorize(id, input.digest, permission)
        const workspace = deps.workspaceManager.get(input.instanceId)
        if (!workspace) throw new PanelExtensionError("missing")
        const result = await read(workspace.path, input, abandoned.signal)
        // Revocation, replacement or closing the project during the read fences its result.
        await deps.store.authorize(id, input.digest, permission)
        if (deps.workspaceManager.get(input.instanceId)?.path !== workspace.path) throw new PanelExtensionError("unavailable")
        return result
      } catch (error) {
        const code = error instanceof z.ZodError ? 400 : error instanceof PanelExtensionError
          ? { missing: 404, disabled: 403, conflict: 409, invalid: 400, limit: 413, unavailable: 503 }[error.code] : 503
        return reply.code(code).send({ error: "Work items unavailable" })
      }
    })
  }
  route("workItems", "repository.workItems.read", listSchema, (directory, { kind, query, page, fresh }, signal) => deps.forge.list(directory, { kind, query, page, fresh }, signal))
  route("workItemUrl", "repository.workItems.read", urlSchema, async (directory, input, signal) => {
    const url = await deps.forge.itemUrl(directory, input.kind, input.number, signal)
    if (!url) throw new PanelExtensionError("unavailable")
    return { url }
  })
  // API 4 `repository.worktrees.read`/`.write`: the host joins these branches to its worktrees and
  // asks the user before each creation; addons never name a branch, remote or revision.
  route("workItemBranches", "repository.worktrees.read", z.object(authority).strict(), async (directory, _input, signal) => {
    const source = await deps.forge.branchSource(directory, signal)
    return source ? { status: "ok", branches: await readWorkItemBranches(directory, source) } : { status: "unavailable" }
  })
  route("workItemBranch", "repository.worktrees.write", urlSchema, async (directory, input, signal) => {
    const source = await deps.forge.branchSource(directory, signal)
    return source ? createWorkItemBranch(directory, source, input.kind, input.number) : { status: "unavailable" }
  })
}
