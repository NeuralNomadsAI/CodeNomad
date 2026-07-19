import path from "path"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { SettingsService } from "../../settings/service"
import type { Logger } from "../../logger"
import { getGitHubWorkspaceContext } from "../../integrations/github/workspace-context"
import { getGitHubWorktreeContext } from "../../integrations/github/worktree-context"
import { createInstallationOctokit, getInstallationToken } from "../../integrations/github/octokit"
import { gitCurrentBranch, gitIsClean, gitPushHead } from "../../integrations/github/git-ops"
import { resolveWorktreeSlugForDirectory } from "../../workspaces/worktree-directory"
import { sanitizeGitHubWebhookPayload } from "../../integrations/github/sanitize-webhook"
import { appendCodeNomadBotSignature } from "../../integrations/github/bot-signature"

interface RouteDeps {
  workspaceManager: WorkspaceManager
  settings: SettingsService
  logger: Logger
}

const AddReactionSchema = z.object({
  op: z.literal("add_reaction"),
  commentId: z.number().int().positive(),
  content: z.enum(["eyes", "rocket", "+1", "-1", "laugh", "confused", "heart", "hooray"]),
})

const AddPrReviewCommentReactionSchema = z.object({
  op: z.literal("add_pr_review_comment_reaction"),
  commentId: z.number().int().positive(),
  content: z.enum(["eyes", "rocket", "+1", "-1", "laugh", "confused", "heart", "hooray"]),
})

const PostIssueCommentSchema = z.object({
  op: z.literal("post_issue_comment"),
  issueNumber: z.number().int().positive(),
  body: z.string().min(1),
})

const PublishPrSchema = z.object({
  op: z.literal("publish_pr"),
  directory: z.string().min(1),
  title: z.string().min(1),
  body: z.string().optional(),
  base: z.string().optional(),
  draft: z.boolean().optional(),
})

const ListIssueCommentsSchema = z.object({
  op: z.literal("list_issue_comments"),
  issueNumber: z.number().int().positive(),
  since: z.string().trim().min(1).optional(),
})

const ListPrReviewCommentsSchema = z.object({
  op: z.literal("list_pr_review_comments"),
  prNumber: z.number().int().positive(),
  since: z.string().trim().min(1).optional(),
})

const GitHubToolSchema = z.discriminatedUnion("op", [
  AddReactionSchema,
  AddPrReviewCommentReactionSchema,
  PostIssueCommentSchema,
  PublishPrSchema,
  ListIssueCommentsSchema,
  ListPrReviewCommentsSchema,
])

export function registerGitHubPluginRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.post<{ Params: { id: string } }>("/workspaces/:id/plugin/integrations/github", async (request, reply) => {
    const workspaceId = request.params.id
    const workspace = deps.workspaceManager.get(workspaceId)
    if (!workspace) {
      reply.code(404)
      return { error: "Workspace not found" }
    }

    const context = getGitHubWorkspaceContext(workspaceId)
    if (!context) {
      reply.code(400)
      return { error: "Workspace is not configured for GitHub" }
    }

    const integrationsConfig = deps.settings.getOwner("config", "integrations")
    const gh = (integrationsConfig as any)?.github
    if (!gh?.enabled || !gh.appId || !gh.privateKeyPath) {
      reply.code(400)
      return { error: "GitHub integration is not configured" }
    }

    let parsed: z.infer<typeof GitHubToolSchema>
    try {
      parsed = GitHubToolSchema.parse(request.body ?? {})
    } catch (error) {
      reply.code(400)
      return { error: error instanceof Error ? error.message : "Invalid GitHub tool request" }
    }

    const token = await getInstallationToken({ appId: gh.appId, privateKeyPath: gh.privateKeyPath }, context.installationId)
    const octokit = createInstallationOctokit({ appId: gh.appId, privateKeyPath: gh.privateKeyPath }, context.installationId)
    const { owner, repo } = context

    try {
      if (parsed.op === "add_reaction") {
        const reaction = await octokit.request("POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions", {
          owner,
          repo,
          comment_id: parsed.commentId,
          content: parsed.content,
          headers: { accept: "application/vnd.github+json" },
        })
        return { ok: true, op: parsed.op, data: sanitizeGitHubWebhookPayload(reaction.data) }
      }

      if (parsed.op === "add_pr_review_comment_reaction") {
        const reaction = await octokit.request("POST /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions", {
          owner,
          repo,
          comment_id: parsed.commentId,
          content: parsed.content,
          headers: { accept: "application/vnd.github+json" },
        })
        return { ok: true, op: parsed.op, data: sanitizeGitHubWebhookPayload(reaction.data) }
      }

      if (parsed.op === "post_issue_comment") {
        const res = await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
          owner,
          repo,
          issue_number: parsed.issueNumber,
          body: appendCodeNomadBotSignature(parsed.body),
        })
        return { ok: true, op: parsed.op, url: (res.data as any)?.html_url, data: sanitizeGitHubWebhookPayload(res.data) }
      }

      if (parsed.op === "list_issue_comments") {
        const data = await listIssueComments(octokit, { owner, repo, issueNumber: parsed.issueNumber, since: parsed.since })
        return { ok: true, op: parsed.op, data }
      }

      if (parsed.op === "list_pr_review_comments") {
        const data = await listPrReviewComments(octokit, { owner, repo, prNumber: parsed.prNumber, since: parsed.since })
        return { ok: true, op: parsed.op, data }
      }

      if (parsed.op === "publish_pr") {
        return await publishPr({ parsed, workspace, workspaceId, context, octokit, token, logger: deps.logger })
      }

      reply.code(400)
      return { error: "Unknown operation" }
    } catch (error) {
      deps.logger.error({ err: error, workspaceId, op: (parsed as any)?.op }, "GitHub tool call failed")
      reply.code(500)
      return { error: error instanceof Error ? error.message : "GitHub operation failed" }
    }
  })
}

async function listIssueComments(octokit: ReturnType<typeof createInstallationOctokit>, params: { owner: string; repo: string; issueNumber: number; since?: string }) {
  const all: any[] = []
  for (let page = 1; page <= 50; page += 1) {
    const res = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner: params.owner,
      repo: params.repo,
      issue_number: params.issueNumber,
      per_page: 100,
      page,
      ...(params.since ? { since: params.since } : {}),
    })
    const items = Array.isArray(res.data) ? res.data : []
    for (const item of items) {
      all.push({
        id: (item as any).id,
        html_url: (item as any).html_url,
        user: { login: (item as any)?.user?.login, type: (item as any)?.user?.type },
        created_at: (item as any).created_at,
        updated_at: (item as any).updated_at,
        body: (item as any).body,
      })
    }
    if (items.length < 100) break
  }
  return all
}

async function listPrReviewComments(octokit: ReturnType<typeof createInstallationOctokit>, params: { owner: string; repo: string; prNumber: number; since?: string }) {
  const all: any[] = []
  for (let page = 1; page <= 50; page += 1) {
    const res = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/comments", {
      owner: params.owner,
      repo: params.repo,
      pull_number: params.prNumber,
      per_page: 100,
      page,
      ...(params.since ? { since: params.since } : {}),
    })
    const items = Array.isArray(res.data) ? res.data : []
    for (const item of items) {
      all.push({
        id: (item as any).id,
        html_url: (item as any).html_url,
        user: { login: (item as any)?.user?.login, type: (item as any)?.user?.type },
        created_at: (item as any).created_at,
        updated_at: (item as any).updated_at,
        body: (item as any).body,
        path: (item as any).path,
        position: (item as any).position,
      })
    }
    if (items.length < 100) break
  }
  return all
}

async function publishPr(params: {
  parsed: z.infer<typeof PublishPrSchema>
  workspace: { path: string }
  workspaceId: string
  context: NonNullable<ReturnType<typeof getGitHubWorkspaceContext>>
  octokit: ReturnType<typeof createInstallationOctokit>
  token: string
  logger: Logger
}) {
  const absDir = path.resolve(params.parsed.directory)
  const workspaceRoot = path.resolve(params.workspace.path)
  const rel = path.relative(workspaceRoot, absDir)
  if (!(rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)))) {
    return { error: "Invalid directory" }
  }

  let base = params.parsed.base ?? params.context.defaultBranch
  if (!params.parsed.base) {
    const slug = await resolveWorktreeSlugForDirectory({
      workspaceId: params.workspaceId,
      workspacePath: params.workspace.path,
      directory: absDir,
      logger: params.logger,
    })
    if (slug) {
      const ctx = getGitHubWorktreeContext(params.workspaceId, slug)
      if (ctx?.publishBase) base = ctx.publishBase
    }
  }

  const branch = await gitCurrentBranch(absDir)
  if (!branch) return { error: "No current branch" }
  const clean = await gitIsClean(absDir)
  if (!clean) return { error: "Working tree has uncommitted changes" }

  await gitPushHead({ cwd: absDir, remoteUrl: params.context.repoUrl, branch, token: params.token })

  let prUrl: string | undefined
  let prNumber: number | undefined
  let pr: unknown
  try {
    const created = await params.octokit.request("POST /repos/{owner}/{repo}/pulls", {
      owner: params.context.owner,
      repo: params.context.repo,
      title: params.parsed.title,
      body: params.parsed.body ? appendCodeNomadBotSignature(params.parsed.body) : undefined,
      head: branch,
      base,
      draft: params.parsed.draft ?? false,
    })
    prUrl = (created.data as any)?.html_url
    prNumber = (created.data as any)?.number
    pr = created.data
  } catch (error: any) {
    if (error?.status !== 422) throw error
    const existing = await params.octokit.request("GET /repos/{owner}/{repo}/pulls", {
      owner: params.context.owner,
      repo: params.context.repo,
      state: "open",
      head: `${params.context.owner}:${branch}`,
    })
    const first = Array.isArray(existing.data) ? existing.data[0] : null
    prUrl = (first as any)?.html_url
    prNumber = (first as any)?.number
    pr = first
  }

  return { ok: true, op: "publish_pr", branch, url: prUrl, number: prNumber, base, data: sanitizeGitHubWebhookPayload(pr) }
}
