import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { GitHubJobRunner } from "../job-runner"

describe("GitHubJobRunner", () => {
  it("dispatches an accepted issue comment through workspace, worktree, context, and OpenCode command setup", async () => {
    const harness = createRunnerHarness()
    harness.runner.enqueue(createIssueCommentJob({ deliveryId: "delivery-1", body: "@codenomad please fix" }))

    await waitFor(() => harness.commandCalls.length === 1)

    assert.equal(harness.workspaceCreateCalls.length, 1)
    assert.equal(harness.workspaceCreateCalls[0]?.options?.extraEnvironment?.CODENOMAD_MODE, "github")

    assert.deepEqual(harness.workspaceContexts[0], {
      workspaceId: "workspace-1",
      context: {
        installationId: 123,
        owner: "my-org",
        repo: "repo-a",
        defaultBranch: "main",
        repoUrl: "https://github.com/my-org/repo-a.git",
        botLogin: "codenomadbot[bot]",
      },
    })
    assert.deepEqual(harness.worktreeContexts[0], {
      workspaceId: "workspace-1",
      worktreeSlug: "codenomad/issue-7",
      context: {
        issueNumber: 7,
        isPullRequest: false,
        publishBase: "main",
      },
    })

    assert.equal(harness.fetchResetCalls[0]?.ref, "main")
    assert.equal(harness.clientConfigs[0]?.directory, "/tmp/my-org/repo-a/.codenomad/worktrees/codenomad-issue-7")
    assert.equal(typeof harness.clientConfigs[0]?.fetch, "function")

    const command = harness.commandCalls[0]
    assert.equal(command?.parameters.sessionID, "session-1")
    assert.equal(command?.parameters.directory, "/tmp/my-org/repo-a/.codenomad/worktrees/codenomad-issue-7")
    assert.equal(command?.parameters.command, "codenomad-github-issue-comment")
    assert.equal(command?.parameters.agent, "build")
    assert.equal(command?.parameters.model, "openai/gpt-5.2")
    assert.equal(command?.parameters.variant, "default")

    const args = JSON.parse(command?.parameters.arguments ?? "{}")
    assert.equal(args.eventKey, "issue_comment.created")
    assert.equal(args.reusedSession, false)
    assert.equal(args.webhook.installation, undefined)
    assert.equal(args.webhook.comment.body, "@codenomad please fix")
  })

  it("aborts an active OpenCode session when a newer webhook supersedes the thread", async () => {
    const harness = createRunnerHarness({ blockFirstCommandUntilAbort: true })

    harness.runner.enqueue(createIssueCommentJob({ deliveryId: "delivery-1", body: "@codenomad first" }))
    await waitFor(() => harness.commandCalls.length === 1)

    harness.runner.enqueue(createIssueCommentJob({ deliveryId: "delivery-2", body: "@codenomad second" }))

    await waitFor(() => harness.abortCalls.length === 1 && harness.commandCalls.length === 2)

    assert.equal(harness.abortCalls[0]?.sessionID, "session-1")
    const secondArgs = JSON.parse(harness.commandCalls[1]?.parameters.arguments ?? "{}")
    assert.equal(secondArgs.webhook.comment.body, "@codenomad second")
  })
})

function createRunnerHarness(options: { blockFirstCommandUntilAbort?: boolean } = {}) {
  const workspace = { id: "workspace-1", path: "/tmp/my-org/repo-a", status: "ready" }
  const workspaceCreateCalls: Array<{ folder: string; name?: string; options?: any }> = []
  const commandCalls: Array<{ parameters: any; options: any }> = []
  const abortCalls: Array<{ sessionID: string; directory?: string }> = []
  const clientConfigs: any[] = []
  const workspaceContexts: any[] = []
  const worktreeContexts: any[] = []
  const fetchResetCalls: any[] = []

  let sessionCounter = 0
  const client = {
    session: {
      list: async () => ({ data: [] }),
      create: async () => ({ data: { id: `session-${++sessionCounter}` } }),
      abort: async (parameters: { sessionID: string; directory?: string }) => {
        abortCalls.push(parameters)
        return { data: {} }
      },
      command: (parameters: any, commandOptions: any) => {
        commandCalls.push({ parameters, options: commandOptions })
        if (options.blockFirstCommandUntilAbort && commandCalls.length === 1) {
          return new Promise((resolve, reject) => {
            const signal = commandOptions?.signal as AbortSignal | undefined
            const abort = () => {
              const error = new Error("Aborted")
              ;(error as any).name = "AbortError"
              reject(error)
            }
            if (signal?.aborted) {
              abort()
              return
            }
            signal?.addEventListener("abort", abort, { once: true })
            void resolve
          })
        }
        return Promise.resolve({ data: { info: {} } })
      },
    },
  }

  const runner = new GitHubJobRunner({
    workspaceManager: {
      create: async (folder: string, name?: string, createOptions?: any) => {
        workspaceCreateCalls.push({ folder, name, options: createOptions })
        return { workspace, created: true }
      },
      get: () => workspace,
      getInstancePort: () => 4321,
      getInstanceAuthorizationHeader: () => "Basic test",
      delete: async () => workspace,
    } as any,
    settings: {
      getOwner: (kind: string, owner: string) => {
        assert.equal(kind, "config")
        if (owner !== "integrations") return {}
        return {
          github: {
            enabled: true,
            appId: "12345",
            privateKeyPath: "/tmp/github-app.pem",
            webhookSecret: "secret",
            workspaceRoot: "/tmp",
            mentionHandle: "codenomad",
            botLogin: "codenomadbot[bot]",
            webhook: {
              agent: "build",
              model: { providerId: "openai", modelId: "gpt-5.2" },
              variant: "default",
            },
            policy: {
              rules: [
                {
                  match: { repo: "my-org/*", event: "issue_comment.created" },
                  allow: { requireMention: true, allowedAuthorAssociations: ["OWNER"] },
                },
              ],
            },
          },
        }
      },
    } as any,
    logger: createLogger(),
    operations: {
      verifyGitHubWebhookSignature: () => true,
      createAppOctokit: () => ({ request: async () => ({ data: { slug: "codenomadbot" } }) }) as any,
      createInstallationOctokit: () => ({ request: async () => ({ data: {} }) }) as any,
      getInstallationToken: async () => "installation-token",
      ensureClonedAndUpdated: async () => undefined,
      ensureCodenomadGitExclude: async () => undefined,
      gitRemoteRefExists: async () => false,
      gitFetchAndResetToRemote: async (params: any) => { fetchResetCalls.push(params) },
      resolveRepoRoot: async (folder: string) => ({ repoRoot: folder, isGitRepo: true }),
      listWorktrees: async () => [],
      createManagedWorktree: async (params: any) => ({
        slug: params.slug,
        directory: "/tmp/my-org/repo-a/.codenomad/worktrees/codenomad-issue-7",
        branch: params.slug,
      }),
      resolveWorktreeDirectory: async () => "/tmp/my-org/repo-a/.codenomad/worktrees/codenomad-issue-7",
      createOpencodeClient: (config: any) => {
        clientConfigs.push(config)
        return client as any
      },
      setGitHubWorkspaceContext: (workspaceId: string, context: any) => { workspaceContexts.push({ workspaceId, context }) },
      clearGitHubWorkspaceContext: () => undefined,
      setGitHubWorktreeContext: (workspaceId: string, worktreeSlug: string, context: any) => { worktreeContexts.push({ workspaceId, worktreeSlug, context }) },
      clearGitHubWorktreeContext: () => undefined,
    },
  })

  return {
    runner,
    workspaceCreateCalls,
    commandCalls,
    abortCalls,
    clientConfigs,
    workspaceContexts,
    worktreeContexts,
    fetchResetCalls,
  }
}

function createIssueCommentJob(params: { deliveryId: string; body: string }) {
  return {
    deliveryId: params.deliveryId,
    event: "issue_comment",
    signature: "sha256=test",
    body: Buffer.from(JSON.stringify({
      action: "created",
      installation: { id: 123 },
      repository: {
        owner: { login: "my-org" },
        name: "repo-a",
        default_branch: "main",
        clone_url: "https://github.com/my-org/repo-a.git",
      },
      issue: { number: 7 },
      comment: {
        id: 99,
        body: params.body,
        user: { login: "alice", type: "User" },
        author_association: "OWNER",
      },
    }), "utf-8"),
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("Timed out waiting for condition")
}

function createLogger() {
  return {
    child: () => createLogger(),
    info: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as any
}
