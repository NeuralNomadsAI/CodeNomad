import os from "os"
import path from "path"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { Agent, fetch as undiciFetch } from "undici"
import type { Logger } from "../../logger"
import type { SettingsService } from "../../settings/service"
import type { WorkspaceManager } from "../../workspaces/manager"
import { createManagedWorktree, listWorktrees, resolveRepoRoot } from "../../workspaces/git-worktrees"
import { ensureCodenomadGitExclude } from "../../workspaces/worktree-map"
import { resolveWorktreeDirectory } from "../../workspaces/worktree-directory"
import { verifyGitHubWebhookSignature } from "./webhook-verify"
import { createAppOctokit, createInstallationOctokit, getInstallationToken } from "./octokit"
import { ensureClonedAndUpdated, gitFetchAndResetToRemote, gitRemoteRefExists } from "./git-ops"
import { clearGitHubWorkspaceContext, setGitHubWorkspaceContext } from "./workspace-context"
import { clearGitHubWorktreeContext, setGitHubWorktreeContext } from "./worktree-context"
import { hasGitHubMentionTrigger, isGitHubActorAllowed } from "./webhook-admission"
import { normalizeGitHubWebhookContext, type GitHubWebhookContext } from "./webhook-normalize"
import { selectGitHubWebhookPolicyDecision, type GitHubWebhookPolicyDecision, type GitHubWebhookPolicyRule } from "./webhook-policy"
import { selectGitHubWebhookCommand } from "./webhook-command"
import { sanitizeGitHubWebhookPayload } from "./sanitize-webhook"
import { appendCodeNomadBotSignature } from "./bot-signature"

// GitHub automation commands can run longer than Node/undici's default response
// header timeout because OpenCode returns the command response only after the
// assistant finishes. Use a dedicated dispatcher with timeouts disabled for this
// local loopback path.
const OPENCODE_FETCH_DISPATCHER = new Agent({ headersTimeout: 0, bodyTimeout: 0 })

const opencodeNoTimeoutFetch: typeof fetch = ((input: any, init?: any) => {
  const mergedInit: any = { ...(init ?? {}), dispatcher: OPENCODE_FETCH_DISPATCHER }

  if (input && typeof input === "object" && typeof input.url === "string" && init === undefined) {
    const req = input as Request
    mergedInit.method = req.method
    mergedInit.headers = req.headers
    mergedInit.redirect = req.redirect
    mergedInit.signal = req.signal
    if (req.body !== null && req.body !== undefined) {
      mergedInit.body = req.body
    }
    if (mergedInit.body !== undefined && mergedInit.duplex === undefined) {
      mergedInit.duplex = "half"
    }
    return (undiciFetch as any)(req.url, mergedInit)
  }

  if (mergedInit.body !== undefined && mergedInit.duplex === undefined) {
    mergedInit.duplex = "half"
  }

  return (undiciFetch as any)(input, mergedInit)
}) as typeof fetch

type GitHubAppSettings = {
  enabled: boolean
  appId?: string
  privateKeyPath?: string
  webhookSecret?: string
  workspaceRoot?: string
  mentionHandle?: string
  commands: Record<string, string>
  webhookAgent?: string
  webhookModel?: { providerId: string; modelId: string }
  webhookVariant?: string
  policyRules: GitHubWebhookPolicyRule[]
  botLogin?: string
}

type EnqueuedJob = {
  deliveryId: string
  event: string
  signature?: string
  body: Buffer
}

type ThreadItem = {
  job: EnqueuedJob
  payload: any
  settings: GitHubAppSettings
  policy: GitHubWebhookPolicyDecision
  eventKey: string
  ctx: GitHubWebhookContext
}

type RequestResultLike<T> = { data: T; error?: undefined } | { data?: undefined; error: unknown }

export class GitHubJobRunner {
  private readonly repoWorkspaceId = new Map<string, string>()
  private readonly activeByRepo = new Map<string, number>()
  private readonly stopTimersByWorkspace = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly seenDeliveries = new Set<string>()
  private cachedBotLogin: string | null = null
  private readonly threads = new Map<string, {
    running: boolean
    pending?: ThreadItem
    current?: { controller: AbortController; cancelRequested: boolean; abortSession?: () => Promise<void> }
  }>()

  constructor(private readonly deps: { workspaceManager: WorkspaceManager; settings: SettingsService; logger: Logger }) {}

  enqueue(job: EnqueuedJob) {
    if (job.deliveryId) {
      if (this.seenDeliveries.has(job.deliveryId)) return
      this.seenDeliveries.add(job.deliveryId)
      if (this.seenDeliveries.size > 5000) this.seenDeliveries.clear()
    }

    const settings = this.readSettings()
    if (!settings.enabled) return this.logReject(job, { enabled: false }, "integration disabled")
    if (!settings.webhookSecret) return this.logReject(job, { enabled: true, webhookSecret: false }, "missing webhookSecret")
    if (!verifyGitHubWebhookSignature({ secret: settings.webhookSecret, signatureHeader: job.signature, body: job.body })) {
      return this.logReject(job, { enabled: true, webhookSecret: true, signature: false }, "invalid signature")
    }

    let rawPayload: any
    try {
      rawPayload = JSON.parse(job.body.toString("utf-8"))
    } catch (error) {
      this.deps.logger.info({ deliveryId: job.deliveryId, event: job.event, err: error }, "GitHub webhook rejected (invalid JSON)")
      return
    }

    const action = typeof rawPayload?.action === "string" ? rawPayload.action.trim() : ""
    const eventKey = action ? `${job.event}.${action}` : job.event
    const ctx = normalizeGitHubWebhookContext({ event: job.event, payload: rawPayload })
    if (!ctx) return this.logReject(job, { normalized: false, eventKey }, "missing required fields")

    const decision = selectGitHubWebhookPolicyDecision(settings.policyRules, { repoFullName: ctx.repoFullName, eventKey })
    if (!decision || !decision.enabled) return this.logReject(job, { policy: false, eventKey, repoFullName: ctx.repoFullName }, "policy")

    const deferAdmission = eventKey === "pull_request.synchronize"
    if (!deferAdmission && !this.isAdmitted(settings, decision, ctx)) return

    const key = `${ctx.owner}/${ctx.repo}#${ctx.number}`
    this.submitToThread(key, { job, payload: rawPayload, settings, policy: decision, eventKey, ctx })
  }

  private isAdmitted(settings: GitHubAppSettings, decision: GitHubWebhookPolicyDecision, ctx: GitHubWebhookContext): boolean {
    const actorOk = isGitHubActorAllowed(
      {
        allowedUsers: decision.allowedUsers,
        allowedAuthorAssociations: decision.allowedAuthorAssociations,
        allowAllActors: decision.allowAllActors,
        denyBots: decision.denyBots,
      },
      { login: ctx.actorLogin, authorAssociation: ctx.actorAssociation, type: ctx.actorType },
    )
    if (!actorOk) {
      this.deps.logger.info({ repoFullName: ctx.repoFullName, author: ctx.actorLogin, rule: decision.ruleName }, "GitHub webhook rejected (actor not allowed)")
      return false
    }

    if (decision.requireMention ?? true) {
      const ok = hasGitHubMentionTrigger({ text: ctx.bodyText, mentionHandle: settings.mentionHandle, botLogin: settings.botLogin })
      if (!ok) {
        this.deps.logger.info({ repoFullName: ctx.repoFullName, author: ctx.actorLogin, rule: decision.ruleName }, "GitHub webhook rejected (no mention trigger)")
        return false
      }
    }
    return true
  }

  private logReject(job: EnqueuedJob, checks: Record<string, unknown>, reason: string) {
    this.deps.logger.info({ deliveryId: job.deliveryId, event: job.event, checks }, `GitHub webhook rejected (${reason})`)
  }

  private submitToThread(key: string, item: ThreadItem) {
    const state = this.threads.get(key) ?? { running: false }
    if (!state.running) {
      state.running = true
      this.threads.set(key, state)
      void this.runThread(key, item)
      return
    }

    this.deps.logger.info({ key, newDeliveryId: item.job.deliveryId }, "New comment received; cancelling active GitHub run")
    state.pending = item
    state.current?.controller.abort()
    state.current!.cancelRequested = true
    if (state.current?.abortSession) void state.current.abortSession().catch(() => undefined)
    this.threads.set(key, state)
  }

  private async runThread(key: string, item: ThreadItem) {
    const state = this.threads.get(key)
    if (!state) return
    const controller = new AbortController()
    state.current = { controller, cancelRequested: false }
    this.threads.set(key, state)
    try {
      await this.handleVerified(item, {
        signal: controller.signal,
        registerAbortSession: (fn) => {
          const current = this.threads.get(key)?.current
          if (!current) return
          current.abortSession = fn
          if (current.cancelRequested) void fn().catch(() => undefined)
        },
      })
    } finally {
      const latest = this.threads.get(key)
      if (!latest) return
      latest.current = undefined
      const pending = latest.pending
      latest.pending = undefined
      if (pending) {
        this.threads.set(key, latest)
        await this.runThread(key, pending)
        return
      }
      latest.running = false
      this.threads.delete(key)
    }
  }

  private readSettings(): GitHubAppSettings {
    const cfg = (this.deps.settings.getOwner("config", "integrations") as any)?.github
    const webhook = cfg?.webhook
    return {
      enabled: Boolean(cfg?.enabled),
      appId: cfg?.appId,
      privateKeyPath: cfg?.privateKeyPath,
      webhookSecret: cfg?.webhookSecret,
      workspaceRoot: cfg?.workspaceRoot,
      mentionHandle: cfg?.mentionHandle,
      botLogin: cfg?.botLogin,
      commands: cfg?.commands && typeof cfg.commands === "object" && !Array.isArray(cfg.commands) ? cfg.commands : {},
      webhookAgent: typeof webhook?.agent === "string" ? webhook.agent : undefined,
      webhookModel: webhook?.model && typeof webhook.model.providerId === "string" && typeof webhook.model.modelId === "string"
        ? { providerId: webhook.model.providerId, modelId: webhook.model.modelId }
        : undefined,
      webhookVariant: typeof webhook?.variant === "string" ? webhook.variant : undefined,
      policyRules: Array.isArray(cfg?.policy?.rules) ? cfg.policy.rules : [],
    }
  }

  private async ensureBotLogin(settings: GitHubAppSettings): Promise<string | null> {
    if (settings.botLogin) return settings.botLogin
    if (this.cachedBotLogin) return this.cachedBotLogin
    if (!settings.appId || !settings.privateKeyPath) return null
    try {
      const appOctokit = createAppOctokit({ appId: settings.appId, privateKeyPath: settings.privateKeyPath })
      const response = await appOctokit.request("GET /app")
      const slug = (response.data as any)?.slug
      if (typeof slug === "string" && slug.trim()) {
        this.cachedBotLogin = `${slug}[bot]`
        return this.cachedBotLogin
      }
    } catch (error) {
      this.deps.logger.debug({ err: error }, "Failed to resolve GitHub App bot login")
    }
    return null
  }

  private async handleVerified(item: ThreadItem, cancel: { signal: AbortSignal; registerAbortSession: (fn: () => Promise<void>) => void }) {
    const { settings, ctx, eventKey, policy, payload } = item
    if (!settings.appId || !settings.privateKeyPath || !settings.webhookSecret) {
      this.deps.logger.error("GitHub integration misconfigured (missing appId/privateKeyPath/webhookSecret)")
      return
    }

    const { owner, repo } = ctx
    const octokit = createInstallationOctokit({ appId: settings.appId, privateKeyPath: settings.privateKeyPath }, ctx.installationId)
    const token = await getInstallationToken({ appId: settings.appId, privateKeyPath: settings.privateKeyPath }, ctx.installationId)
    const botLogin = await this.ensureBotLogin(settings)
    if (botLogin && ctx.actorLogin === botLogin) return
    if (eventKey === "pull_request.synchronize") {
      if ((policy.requireMention ?? true) && !hasGitHubMentionTrigger({ text: ctx.bodyText, mentionHandle: settings.mentionHandle, botLogin: settings.botLogin })) {
        this.deps.logger.info({ repoFullName: ctx.repoFullName, author: ctx.actorLogin, rule: policy.ruleName }, "GitHub webhook rejected (no mention trigger)")
        return
      }
    } else if (!this.isAdmitted(settings, policy, ctx)) {
      return
    }

    if (eventKey === "pull_request.synchronize") {
      const ok = await this.isPullRequestSynchronizeActorAllowed({ octokit, owner, repo, ctx, policy })
      if (!ok) return
    }

    await this.addReadReaction(octokit, ctx).catch((error) => this.deps.logger.warn({ err: error }, "Failed to add GitHub read reaction"))

    const workspaceRoot = this.resolveWorkspaceRoot(settings)
    const repoDir = path.join(workspaceRoot, owner, repo)
    await ensureClonedAndUpdated({ repoUrl: ctx.repoUrl, directory: repoDir, defaultBranch: ctx.defaultBranch, token })
    await ensureCodenomadGitExclude(repoDir, this.deps.logger).catch(() => undefined)

    const fullName = `${owner}/${repo}`
    const workspaceId = await this.ensureWorkspace(fullName, repoDir)
    this.acquireWorkspace(fullName, workspaceId)

    try {
      setGitHubWorkspaceContext(workspaceId, { installationId: ctx.installationId, owner, repo, defaultBranch: ctx.defaultBranch, repoUrl: ctx.repoUrl, botLogin: botLogin ?? undefined })
      const { worktreeSlug, worktreeDir } = await this.prepareWorktree({ workspaceId, repoDir, ctx, octokit, token, botLogin })
      const selected = policy.command ? { command: policy.command } : selectGitHubWebhookCommand({ eventKey, serverCommands: settings.commands })
      await this.runOpencode({
        workspaceId,
        worktreeSlug,
        worktreeDir,
        payload,
        owner,
        repo,
        isPullRequest: ctx.isPullRequest,
        threadNumber: ctx.number,
        eventKey,
        command: selected.command,
        agent: policy.agent ?? settings.webhookAgent,
        model: policy.model ?? settings.webhookModel,
        variant: policy.variant ?? settings.webhookVariant,
        signal: cancel.signal,
        registerAbortSession: cancel.registerAbortSession,
      })
      this.deps.logger.info({ owner, repo, number: ctx.number }, "GitHub job completed")
    } catch (error) {
      if (cancel.signal.aborted || (error as any)?.name === "AbortError") {
        this.deps.logger.info({ owner, repo, number: ctx.number }, "GitHub run superseded; skipping failure comment")
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      this.deps.logger.error({ err: error, owner, repo }, "GitHub job failed")
      await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        owner,
        repo,
        issue_number: ctx.number,
        body: appendCodeNomadBotSignature(`Automation failed.\n\n${message}`),
      }).catch((commentError) => this.deps.logger.warn({ err: commentError, owner, repo }, "Failed to post failure comment"))
    } finally {
      this.releaseWorkspace(fullName, workspaceId)
    }
  }

  private async prepareWorktree(params: {
    workspaceId: string
    repoDir: string
    ctx: GitHubWebhookContext
    octokit: ReturnType<typeof createInstallationOctokit>
    token: string
    botLogin: string | null
  }): Promise<{ worktreeSlug: string; worktreeDir: string }> {
    const { ctx, repoDir, token } = params
    if (ctx.isPullRequest) {
      const pr = await params.octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner: ctx.owner, repo: ctx.repo, pull_number: ctx.number })
      const prAuthorLogin = (pr.data as any)?.user?.login
      const headRef = (pr.data as any)?.head?.ref
      const headRepoFullName = (pr.data as any)?.head?.repo?.full_name
      const baseRepoFullName = (pr.data as any)?.base?.repo?.full_name
      const baseRef = (pr.data as any)?.base?.ref
      if (typeof baseRef !== "string" || !baseRef.trim()) throw new Error("PR payload missing base ref")
      const isFromFork = Boolean(headRepoFullName && baseRepoFullName && headRepoFullName !== baseRepoFullName)
      const botOwned = Boolean(params.botLogin && prAuthorLogin && prAuthorLogin === params.botLogin)
      const worktreeSlug = botOwned && typeof headRef === "string" && headRef.trim() ? headRef.trim() : `codenomad/pr-${ctx.number}`
      const worktreeDir = (await this.ensureWorktree({ repoDir, workspaceFolder: repoDir, slug: worktreeSlug })).directory
      const hasRemoteBranch = await gitRemoteRefExists({ cwd: worktreeDir, remoteUrl: ctx.repoUrl, ref: `refs/heads/${worktreeSlug}`, token })
      await gitFetchAndResetToRemote({ cwd: worktreeDir, remoteUrl: ctx.repoUrl, ref: hasRemoteBranch ? worktreeSlug : `pull/${ctx.number}/head`, token })
      const publishBase = botOwned ? baseRef.trim() : typeof headRef === "string" && headRef.trim() && !isFromFork ? headRef.trim() : baseRef.trim()
      setGitHubWorktreeContext(params.workspaceId, worktreeSlug, { issueNumber: ctx.number, isPullRequest: true, publishBase, prNumber: ctx.number, prFromFork: isFromFork, prAuthorLogin })
      return { worktreeSlug, worktreeDir }
    }

    const worktreeSlug = `codenomad/issue-${ctx.number}`
    const worktreeDir = (await this.ensureWorktree({ repoDir, workspaceFolder: repoDir, slug: worktreeSlug })).directory
    const hasRemoteBotBranch = await gitRemoteRefExists({ cwd: worktreeDir, remoteUrl: ctx.repoUrl, ref: `refs/heads/${worktreeSlug}`, token })
    await gitFetchAndResetToRemote({ cwd: worktreeDir, remoteUrl: ctx.repoUrl, ref: hasRemoteBotBranch ? worktreeSlug : ctx.defaultBranch, token })
    setGitHubWorktreeContext(params.workspaceId, worktreeSlug, { issueNumber: ctx.number, isPullRequest: false, publishBase: ctx.defaultBranch })
    return { worktreeSlug, worktreeDir }
  }

  private async ensureWorktree(params: { repoDir: string; workspaceFolder: string; slug: string }) {
    const { repoRoot, isGitRepo } = await resolveRepoRoot(params.workspaceFolder, this.deps.logger)
    if (!isGitRepo) throw new Error("Workspace is not a Git repository")
    const existing = await listWorktrees({ repoRoot, workspaceFolder: params.workspaceFolder, logger: this.deps.logger })
    const match = existing.find((wt) => wt.slug === params.slug)
    if (match) return { slug: match.slug, directory: match.directory, branch: match.branch }
    return createManagedWorktree({ repoRoot, workspaceFolder: params.workspaceFolder, slug: params.slug, logger: this.deps.logger })
  }

  private resolveWorkspaceRoot(settings: GitHubAppSettings): string {
    if (settings.workspaceRoot) return settings.workspaceRoot.startsWith("~/") ? path.join(process.env.HOME ?? os.homedir(), settings.workspaceRoot.slice(2)) : settings.workspaceRoot
    return path.join(process.env.HOME ?? os.homedir(), ".config", "codenomad", "github-workspace")
  }

  private async ensureWorkspace(repoFullName: string, repoDir: string): Promise<string> {
    const existingId = this.repoWorkspaceId.get(repoFullName)
    if (existingId) {
      const existing = this.deps.workspaceManager.get(existingId)
      if (existing?.status === "ready") return existingId
    }
    const { workspace } = await this.deps.workspaceManager.create(repoDir, repoFullName, { forceNew: true, extraEnvironment: { CODENOMAD_MODE: "github" } })
    this.repoWorkspaceId.set(repoFullName, workspace.id)
    return workspace.id
  }

  private acquireWorkspace(repoFullName: string, workspaceId: string) {
    this.activeByRepo.set(repoFullName, (this.activeByRepo.get(repoFullName) ?? 0) + 1)
    const timer = this.stopTimersByWorkspace.get(workspaceId)
    if (timer) {
      clearTimeout(timer)
      this.stopTimersByWorkspace.delete(workspaceId)
    }
  }

  private releaseWorkspace(repoFullName: string, workspaceId: string) {
    const next = Math.max(0, (this.activeByRepo.get(repoFullName) ?? 0) - 1)
    if (next > 0) {
      this.activeByRepo.set(repoFullName, next)
      return
    }
    this.activeByRepo.delete(repoFullName)
    const timer = setTimeout(() => {
      void this.deps.workspaceManager.delete(workspaceId).catch((error) => this.deps.logger.warn({ err: error, workspaceId }, "Failed to stop GitHub workspace")).finally(() => {
        this.stopTimersByWorkspace.delete(workspaceId)
        clearGitHubWorkspaceContext(workspaceId)
        clearGitHubWorktreeContext(workspaceId)
        if (this.repoWorkspaceId.get(repoFullName) === workspaceId) this.repoWorkspaceId.delete(repoFullName)
      })
    }, 30_000)
    this.stopTimersByWorkspace.set(workspaceId, timer)
  }

  private async runOpencode(params: {
    workspaceId: string
    worktreeSlug: string
    worktreeDir: string
    payload: any
    owner: string
    repo: string
    isPullRequest: boolean
    threadNumber: number
    eventKey: string
    command: string
    agent?: string
    model?: { providerId: string; modelId: string }
    variant?: string
    signal: AbortSignal
    registerAbortSession: (fn: () => Promise<void>) => void
  }) {
    const workspace = this.deps.workspaceManager.get(params.workspaceId)
    if (!workspace) throw new Error("Workspace not found")
    const port = this.deps.workspaceManager.getInstancePort(params.workspaceId)
    if (!port) throw new Error("Workspace instance is not ready")
    const directory = await resolveWorktreeDirectory({ workspaceId: params.workspaceId, workspacePath: workspace.path, worktreeSlug: params.worktreeSlug, logger: this.deps.logger })
    if (!directory) throw new Error("Worktree not found")
    const authorization = this.deps.workspaceManager.getInstanceAuthorizationHeader(params.workspaceId)
    const client = createOpencodeClient({
      baseUrl: `http://127.0.0.1:${port}/`,
      ...(authorization ? { headers: { authorization } } : {}),
      fetch: opencodeNoTimeoutFetch,
      directory,
    } as any)

    const threadTitle = `github-${normalizeTitlePart(params.owner)}-${normalizeTitlePart(params.repo)}-${params.isPullRequest ? "pr" : "issue"}-${params.threadNumber}`
    let sessionId: string | null = null
    let reusedSession = false
    try {
      const listed = await unwrap<any>(client.session.list({ directory, search: threadTitle, limit: 20 }, { signal: params.signal }), "session.list")
      const items = Array.isArray((listed as any)?.data) ? (listed as any).data : Array.isArray(listed) ? listed : []
      const matches = items.filter((s: any) => s?.title === threadTitle && typeof s?.id === "string")
      matches.sort((a: any, b: any) => Number(b?.time?.updated ?? b?.time?.created ?? 0) - Number(a?.time?.updated ?? a?.time?.created ?? 0))
      if (matches[0]?.id) {
        sessionId = matches[0].id
        reusedSession = true
      }
    } catch {
      // Fall through to new session.
    }

    if (!sessionId) {
      const created = await unwrap<any>(client.session.create({ directory, title: threadTitle }, { signal: params.signal }), "session.create")
      if (!created?.id || typeof created.id !== "string") throw new Error("OpenCode session.create returned no id")
      sessionId = created.id
    }
    if (!sessionId) throw new Error("Failed to resolve OpenCode session id")
    const resolvedSessionId: string = sessionId

    params.registerAbortSession(async () => {
      await client.session.abort({ sessionID: resolvedSessionId, directory }, { throwOnError: false }).catch(() => undefined)
    })

    const argumentsJson = JSON.stringify({ eventKey: params.eventKey, reusedSession, webhook: sanitizeGitHubWebhookPayload(params.payload) }, null, 2)
    const response = await unwrap<any>(client.session.command({
      sessionID: resolvedSessionId,
      directory,
      command: params.command,
      arguments: argumentsJson,
      ...(params.agent ? { agent: params.agent } : {}),
      ...(params.model ? { model: `${params.model.providerId}/${params.model.modelId}` } : {}),
      ...(params.variant ? { variant: params.variant } : {}),
    }, { signal: params.signal }), "session.command")

    const infoError = response?.info?.error
    if (infoError) {
      const message = typeof infoError?.data?.message === "string" ? infoError.data.message : typeof infoError?.message === "string" ? infoError.message : JSON.stringify(infoError)
      throw new Error(`OpenCode assistant error: ${message}`)
    }
  }

  private async isPullRequestSynchronizeActorAllowed(params: {
    octokit: ReturnType<typeof createInstallationOctokit>
    owner: string
    repo: string
    ctx: GitHubWebhookContext
    policy: GitHubWebhookPolicyDecision
  }): Promise<boolean> {
    const login = (params.ctx.actorLogin ?? "").trim()
    if (!login) return false
    if (params.policy.denyBots && (params.ctx.actorType ?? "").toLowerCase() === "bot") return false
    if (params.policy.allowAllActors) return true
    if (params.policy.allowPrAuthor && params.ctx.prAuthorLogin?.toLowerCase() === login.toLowerCase()) return true
    if (params.policy.allowedUsers.map((u) => u.toLowerCase()).includes(login.toLowerCase())) return true
    if (isGitHubActorAllowed({ allowedUsers: [], allowedAuthorAssociations: params.policy.allowedAuthorAssociations }, {
      login,
      authorAssociation: params.ctx.actorAssociation,
      type: params.ctx.actorType,
    })) return true

    const associations = params.policy.allowedAuthorAssociations.length > 0 ? params.policy.allowedAuthorAssociations : ["OWNER", "COLLABORATOR"]
    const allowed = new Set(associations.map((value) => value.toUpperCase()))
    if (allowed.has("OWNER") || allowed.has("COLLABORATOR")) {
      if (await this.isRepoCollaborator(params.octokit, params.owner, params.repo, login)) return true
    }
    if (allowed.has("MEMBER")) {
      if (await this.isOrgMember(params.octokit, params.owner, login)) return true
    }
    return false
  }

  private async isRepoCollaborator(octokit: ReturnType<typeof createInstallationOctokit>, owner: string, repo: string, username: string): Promise<boolean> {
    try {
      await octokit.request("GET /repos/{owner}/{repo}/collaborators/{username}/permission", { owner, repo, username })
      return true
    } catch {
      return false
    }
  }

  private async isOrgMember(octokit: ReturnType<typeof createInstallationOctokit>, org: string, username: string): Promise<boolean> {
    try {
      await octokit.request("GET /orgs/{org}/members/{username}", { org, username })
      return true
    } catch {
      return false
    }
  }

  private async addReadReaction(octokit: ReturnType<typeof createInstallationOctokit>, ctx: GitHubWebhookContext) {
    if (ctx.issueCommentId) {
      await octokit.request("POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions", { owner: ctx.owner, repo: ctx.repo, comment_id: ctx.issueCommentId, content: "eyes", headers: { accept: "application/vnd.github+json" } })
    } else if (ctx.reviewCommentId) {
      await octokit.request("POST /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions", { owner: ctx.owner, repo: ctx.repo, comment_id: ctx.reviewCommentId, content: "eyes", headers: { accept: "application/vnd.github+json" } })
    } else if (ctx.isPullRequest) {
      await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/reactions", { owner: ctx.owner, repo: ctx.repo, issue_number: ctx.number, content: "eyes", headers: { accept: "application/vnd.github+json" } })
    }
  }
}

async function unwrap<T>(promise: Promise<RequestResultLike<T> | undefined>, label: string): Promise<T> {
  const result = await promise
  if (!result) throw new Error(`${label} returned no result`)
  if ((result as any).error) {
    const err = (result as any).error
    const msg = err instanceof Error ? err.message : JSON.stringify(err)
    throw new Error(`${label} failed: ${msg}`)
  }
  return (result as any).data as T
}

function normalizeTitlePart(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
}
