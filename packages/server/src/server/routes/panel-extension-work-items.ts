import { z } from "zod"
import type { FastifyInstance } from "fastify"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { PanelExtensionStore } from "../../panel-extensions/store"
import { PanelExtensionError } from "../../panel-extensions/archive"
import { FORGE_MAX_PAGE, type ForgeWorkItems } from "../../forge/work-items"
import { createWorkItemBranch, lookupWorkItemBranch, readWorkItemBranches, workItemRepository } from "../../forge/work-item-branches"
import type { PanelExtensionPermission } from "../../panel-extensions/contract"

const kind = z.enum(["issue", "pullRequest"])
const authority = { instanceId: z.string().min(1).max(256), digest: z.string().regex(/^[a-f0-9]{64}$/) }
const idSchema = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{1,39}\.[a-z][a-z0-9-]{1,39}$/) }).strict()
const listSchema = z.object({ ...authority, kind, query: z.string().max(200), page: z.number().int().min(1).max(FORGE_MAX_PAGE), fresh: z.boolean() }).strict()
const urlSchema = z.object({ ...authority, kind, number: z.number().int().min(1).max(999_999_999) }).strict()
// `repository` is the identity the host's dialog showed: a write for another one is refused.
const branchSchema = urlSchema.extend({ repository: z.string().min(3).max(1024), fromSlug: z.string().min(1).max(200).optional() }).strict()

/**
 * `repository.workItems.read` (API 3, and API 4 alongside the worktree permissions below): bounded issue and pull request pages of
 * the project's forge repository, and their web pages. The host owns the
 * project folder, remote and credentials; addons only choose kind, query, page
 * or number. Consent is checked before and after each read.
 */
export function registerPanelExtensionWorkItemRoutes(app: FastifyInstance, deps: {
  store: PanelExtensionStore; workspaceManager: Pick<WorkspaceManager, "get" | "getWorktrees">; forge: ForgeWorkItems
}) {
  const route = <T extends z.ZodType<{ instanceId: string; digest: string }>>(method: string, permission: PanelExtensionPermission, schema: T,
    read: (directory: string, input: z.infer<T>, signal: AbortSignal, current: () => Promise<void>) => Promise<unknown>) => {
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
        // Revocation, replacement or closing the project during the read fences its result (and a write, before it writes).
        const current = async () => {
          await deps.store.authorize(id, input.digest, permission)
          if (deps.workspaceManager.get(input.instanceId)?.path !== workspace.path) throw new PanelExtensionError("unavailable")
        }
        const result = await read(workspace.path, input, abandoned.signal, current)
        await current()
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
    const branches = source && await readWorkItemBranches(directory, source, signal)
    return branches ? { status: "ok", branches } : { status: "unavailable" }
  })
  // Opening looks up the item's own link, beyond the listing's bound.
  route("workItemBranchLookup", "repository.worktrees.read", urlSchema, async (directory, input, signal) => {
    const source = await deps.forge.branchSource(directory, signal)
    return source ? lookupWorkItemBranch(directory, source, input.kind, input.number, signal) : { status: "unavailable" }
  })
  // `fromSlug` is the host's displayed worktree, whose HEAD a new issue branch starts from.
  route("workItemBranch", "repository.worktrees.write", branchSchema, async (directory, input, signal, current) => {
    const source = await deps.forge.branchSource(directory, signal)
    if (!source) return { status: "unavailable" }
    if (workItemRepository(source) !== input.repository) return { status: "changed" }
    // Only an issue starts from the family's checkout; a pull request starts from its fetched head.
    const fromSlug = input.kind === "issue" ? input.fromSlug : undefined
    const worktree = fromSlug === undefined ? undefined : (await deps.workspaceManager.getWorktrees(input.instanceId, "cached"))
      .worktrees.find(worktree => worktree.slug === fromSlug && !worktree.nestedFolderMissing)
    // HEAD of the checkout root, as worktree creation reads it, never of a repository nested in the opened folder.
    const base = worktree?.registeredDirectory ?? worktree?.directory
    if (fromSlug !== undefined && !base) return { status: "unavailable" }
    return createWorkItemBranch(directory, source, input.kind, input.number, { base, check: current, signal })
  })
}
