import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import Fastify from "fastify"
import { registerWorktreeRoutes } from "./worktrees"
import { registerInstanceProxyRoutes } from "../http-server"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { fixtureCatalogue } from "../../workspaces/__tests__/native-worktree-fixture"

test("a family move for an expected branch is refused once the target checks out another one", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "codenomad-move-branch-")), repo = path.join(root, "main"), child = path.join(root, "child")
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim()
  git(root, "init", "-q", "-b", "main", repo)
  git(repo, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "base")
  git(repo, "worktree", "add", "-q", "-b", "issue-12", child)
  const entry = (await fixtureCatalogue(repo)).worktrees.find(worktree => worktree.branch === "issue-12")!
  const session = { id: "session", projectID: "project", location: { directory: repo }, time: { created: 1, updated: 1 } }
  const client = {
    rpc: () => ({ scheduleCarrierRead: async () => ({ owned: false }) }),
    location: { get: async ({ location }: any) => ({ directory: location.directory, project: { id: "project", canonical: repo, directory: repo } }) },
    session: { get: async () => structuredClone(session), list: async () => ({ data: [structuredClone(session)], cursor: {} }), active: async () => ({}),
      move: async ({ directory }: any) => { session.location = { directory } } },
  }
  const app = Fastify()
  registerWorktreeRoutes(app, { worktreeDeletionFence: new WorktreeDeletionFence(), workspaceManager: {
    get: () => ({ id: "workspace", path: repo }), getWorktrees: () => fixtureCatalogue(repo), getServiceLocation: () => ({ directory: repo }),
    getServiceDirectoryForPath: async (_id: string, directory: string) => directory, getWorktreeIdentityForPath: async (_id: string, directory: string) => directory,
    // Same commit, another branch, after the route's first inventory read.
    getSharedServiceClient: async () => { git(child, "switch", "-q", "-c", "unrelated"); return client },
  } as any })
  try {
    const response = await app.inject({ method: "POST", url: "/api/workspaces/workspace/sessions/session/worktree",
      payload: { worktreeSlug: entry.slug, branch: "issue-12" } })
    assert.equal(response.statusCode, 409, response.body)
    assert.equal(session.location.directory, repo, "the family stays")
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }) }
})

test("a worktree family move blocks concurrent prompts targeting a sibling child member before dispatch", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "codenomad-move-family-")), repo = path.join(root, "main"), childWt = path.join(root, "child")
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim()
  git(root, "init", "-q", "-b", "main", repo)
  git(repo, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "base")
  git(repo, "worktree", "add", "-q", "-b", "issue-13", childWt)
  const entry = (await fixtureCatalogue(repo)).worktrees.find(worktree => worktree.branch === "issue-13")!
  const rootSession = { id: "ses_root", projectID: "project", location: { directory: repo }, time: { created: 1, updated: 1 } }
  const childSession = { id: "ses_child", parentID: "ses_root", projectID: "project", location: { directory: repo }, time: { created: 2, updated: 2 } }
  const sessions = new Map([["ses_root", rootSession], ["ses_child", childSession]])
  let releaseMove!: () => void
  let moveEntered!: () => void
  const inMove = new Promise<void>(resolve => { moveEntered = resolve })
  const forwarded: string[] = []
  const client = {
    rpc: () => ({ scheduleCarrierRead: async () => ({ owned: false }) }),
    location: { get: async ({ location }: any) => ({ directory: location.directory, project: { id: "project", canonical: repo, directory: repo } }) },
    session: {
      get: async ({ sessionID }: any) => structuredClone(sessions.get(sessionID)),
      list: async () => ({ data: [structuredClone(rootSession), structuredClone(childSession)], cursor: {} }),
      active: async () => ({}),
      environment: async () => { forwarded.push("env") },
      move: async ({ sessionID, directory }: any) => {
        if (sessionID === "ses_root") {
          moveEntered()
          await new Promise<void>(resolve => { releaseMove = resolve })
        }
        sessions.get(sessionID)!.location = { directory }
      },
    },
  }
  const fence = new WorktreeDeletionFence()
  const connection = {
    endpoint: { url: "http://private-fixture.invalid" },
    client,
    profile: async () => "modern" as const,
    assertCurrent() {},
    invalidate() {},
    fetch: async (_input: unknown, _init?: unknown, _media?: unknown, dispatchHooks?: { beforeFetch?: () => Promise<void>; onDispatch?: () => void }) => {
      await dispatchHooks?.beforeFetch?.()
      dispatchHooks?.onDispatch?.()
      forwarded.push("forward")
      return Response.json({ ok: true })
    },
  }
  const workspaceManager = {
    get: () => ({ id: "workspace", path: repo }),
    getWorktrees: () => fixtureCatalogue(repo),
    getServiceLocation: () => ({ directory: repo }),
    getServiceDirectory: () => repo,
    getServiceDirectoryForPath: async (_id: string, directory: string) => directory,
    getWorktreeIdentityForPath: async (_id: string, directory: string) => directory,
    getSharedServiceClient: async () => client,
    getSharedServiceConnection: async () => connection,
    getSharedServiceEndpoint: async () => connection.endpoint,
    getInstanceAuthorizationHeader: () => undefined,
    getSessionEnvironment: async () => ({}),
    ownsLocation: async () => true,
    ownsDirectory: async () => true,
    ownsPath: async () => true,
  } as any
  const app = Fastify()
  registerWorktreeRoutes(app, { worktreeDeletionFence: fence, workspaceManager })
  registerInstanceProxyRoutes(app, {
    workspaceManager,
    worktreeDeletionFence: fence,
    logger: { debug() {}, error() {}, isLevelEnabled: () => false } as any,
  })
  try {
    const movePromise = app.inject({
      method: "POST",
      url: "/api/workspaces/workspace/sessions/ses_root/worktree",
      payload: { worktreeSlug: entry.slug, branch: "issue-13" },
    })
    await inMove
    const promptResponse = await app.inject({
      method: "POST",
      url: "/workspaces/workspace/instance/api/session/ses_child/prompt",
      payload: { text: "blocked during family move" },
    })
    assert.equal(promptResponse.statusCode, 409, promptResponse.body)
    assert.deepEqual(forwarded, [], "child prompt must be blocked before environment or dispatch")
    releaseMove()
    const moveResponse = await movePromise
    assert.equal(moveResponse.statusCode, 200, moveResponse.body)
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }) }
})
