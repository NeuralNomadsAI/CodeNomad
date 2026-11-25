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
import { markDispatchHookAwareFetch } from "../../opencode/compatibility/transport"
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
  const moveGate = new Promise<void>(resolve => { releaseMove = resolve })
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
          await moveGate
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
    fetch: markDispatchHookAwareFetch(async (_input: unknown, _init?: unknown, _media?: unknown, dispatchHooks?: { beforeFetch?: () => Promise<void>; onDispatch?: () => void }) => {
      await dispatchHooks?.beforeFetch?.()
      dispatchHooks?.onDispatch?.()
      forwarded.push("forward")
      return Response.json({ ok: true })
    }),
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
    let moveReleased = false
    const releaseMoveOnce = () => {
      if (moveReleased) return
      moveReleased = true
      releaseMove?.()
    }
    try {
      await Promise.race([
        inMove,
        movePromise.then((res) => {
          throw new Error(`move completed before entering move hook (${res.statusCode}): ${res.body}`)
        }),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error("timed out waiting for family move to enter lock")), 25000)
          timer.unref?.()
        }),
      ])
      const promptResponse = await app.inject({
        method: "POST",
        url: "/workspaces/workspace/instance/api/session/ses_child/prompt",
        payload: { text: "blocked during family move" },
      })
      assert.equal(promptResponse.statusCode, 409, promptResponse.body)
      assert.equal(promptResponse.headers["x-codenomad-before-dispatch"], "1")
      assert.deepEqual(promptResponse.json(), { error: "Session move is in progress" })
      assert.deepEqual(forwarded, [], "child prompt must be blocked before environment or dispatch")
    } finally {
      releaseMoveOnce()
    }
    const moveResponse = await movePromise
    assert.equal(moveResponse.statusCode, 200, moveResponse.body)
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }) }
})

test("a family move fails fast while a session mutation is active, widens for a late child, and blocks imports targeting locked members", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "codenomad-move-late-child-")), repo = path.join(root, "main"), childWt = path.join(root, "child")
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim()
  git(root, "init", "-q", "-b", "main", repo)
  git(repo, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "base")
  git(repo, "worktree", "add", "-q", "-b", "issue-14", childWt)
  const entry = (await fixtureCatalogue(repo)).worktrees.find(worktree => worktree.branch === "issue-14")!
  const rootSession = { id: "ses_root", projectID: "project", location: { directory: repo }, time: { created: 1, updated: 1 } }
  const lateChild = { id: "ses_child_late", parentID: "ses_root", projectID: "project", location: { directory: repo }, time: { created: 2, updated: 2 } }
  const sessions = new Map<string, any>([["ses_root", rootSession]])
  let releaseMove!: () => void
  const moveGate = new Promise<void>(resolve => { releaseMove = resolve })
  let moveEntered!: () => void
  const inMove = new Promise<void>(resolve => { moveEntered = resolve })
  const forwarded: string[] = []
  const fence = new WorktreeDeletionFence()
  let listCalls = 0
  let injectLateChildOnSecondList = false
  const client = {
    rpc: () => ({ scheduleCarrierRead: async () => ({ owned: false }) }),
    location: { get: async ({ location }: any) => ({ directory: location.directory, project: { id: "project", canonical: repo, directory: repo } }) },
    session: {
      get: async ({ sessionID }: any) => structuredClone(sessions.get(sessionID)),
      list: async () => {
        listCalls += 1
        if (injectLateChildOnSecondList && listCalls === 2) {
          sessions.set("ses_child_late", lateChild)
        }
        return { data: Array.from(sessions.values(), s => structuredClone(s)), cursor: {} }
      },
      active: async () => ({}),
      environment: async () => { forwarded.push("env") },
      move: async ({ sessionID, directory }: any) => {
        if (sessionID === "ses_root") {
          moveEntered()
          await moveGate
        }
        sessions.get(sessionID)!.location = { directory }
      },
    },
  }
  const connection = {
    endpoint: { url: "http://private-fixture.invalid" },
    client,
    profile: async () => "modern" as const,
    assertCurrent() {},
    invalidate() {},
    fetch: markDispatchHookAwareFetch(async (_input: unknown, _init?: unknown, _media?: unknown, dispatchHooks?: { beforeFetch?: () => Promise<void>; onDispatch?: () => void }) => {
      await dispatchHooks?.beforeFetch?.()
      dispatchHooks?.onDispatch?.()
      forwarded.push("forward")
      return Response.json({ ok: true })
    }),
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
    // Active mutation on ses_root rejects a move immediately with 409 (parity with Rust fence::try_block).
    const releaseParentPrompt = fence.enterSession("ses_root")!
    assert.ok(releaseParentPrompt)
    try {
      const blockedMove = await app.inject({
        method: "POST",
        url: "/api/workspaces/workspace/sessions/ses_root/worktree",
        payload: { worktreeSlug: entry.slug, branch: "issue-14" },
      })
      assert.equal(blockedMove.statusCode, 409, blockedMove.body)
      assert.deepEqual(blockedMove.json(), { error: "A session request is in progress" })
    } finally {
      releaseParentPrompt()
    }

    // Now let a late child appear between the first inventory read and the locked re-read.
    listCalls = 0
    injectLateChildOnSecondList = true
    const movePromise = app.inject({
      method: "POST",
      url: "/api/workspaces/workspace/sessions/ses_root/worktree",
      payload: { worktreeSlug: entry.slug, branch: "issue-14" },
    })
    let moveReleased = false
    const releaseMoveOnce = () => {
      if (moveReleased) return
      moveReleased = true
      releaseMove?.()
    }
    try {
      await Promise.race([
        inMove,
        movePromise.then((res) => {
          throw new Error(`move completed before entering move hook (${res.statusCode}): ${res.body}`)
        }),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error("timed out waiting for retried family move")), 25000)
          timer.unref?.()
        }),
      ])
      const childPrompt = await app.inject({
        method: "POST",
        url: "/workspaces/workspace/instance/api/session/ses_child_late/prompt",
        payload: { text: "must be blocked under widened family lock" },
      })
      assert.equal(childPrompt.statusCode, 409, childPrompt.body)
      assert.equal(childPrompt.headers["x-codenomad-before-dispatch"], "1")
      assert.deepEqual(childPrompt.json(), { error: "Session move is in progress" })

      const importChild = await app.inject({
        method: "POST",
        url: "/workspaces/workspace/instance/api/experimental/session/import",
        payload: { info: { id: "ses_imported", parentID: "ses_root", directory: repo } },
      })
      assert.equal(importChild.statusCode, 409, importChild.body)
      assert.deepEqual(importChild.json(), { error: "Session move is in progress" })

      // An import targeting a locked session solely by info.id (without parentID) must also be blocked.
      const importById = await app.inject({
        method: "POST",
        url: "/workspaces/workspace/instance/api/experimental/session/import",
        payload: { info: { id: "ses_child_late", directory: repo } },
      })
      assert.equal(importById.statusCode, 409, importById.body)
      assert.deepEqual(importById.json(), { error: "Session move is in progress" })
      assert.deepEqual(forwarded, [])
    } finally {
      releaseMoveOnce()
    }
    const moveResponse = await movePromise
    assert.equal(moveResponse.statusCode, 200, moveResponse.body)
    assert.equal(lateChild.location.directory, childWt)
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }) }
})

test("a child appearing already at the destination mid-move triggers cardinality failure and rollback", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "codenomad-move-rollback-")), repo = path.join(root, "main"), childWt = path.join(root, "child")
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim()
  git(root, "init", "-q", "-b", "main", repo)
  git(repo, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "base")
  git(repo, "worktree", "add", "-q", "-b", "issue-15", childWt)
  const entry = (await fixtureCatalogue(repo)).worktrees.find(worktree => worktree.branch === "issue-15")!
  const rootSession = { id: "ses_root", projectID: "project", location: { directory: repo }, time: { created: 1, updated: 1 } }
  const midMoveChild = { id: "ses_mid_child", parentID: "ses_root", projectID: "project", location: { directory: childWt }, time: { created: 2, updated: 2 } }
  const sessions = new Map<string, any>([["ses_root", rootSession]])
  const moves: Array<{ id: string; directory: string }> = []
  const client = {
    rpc: () => ({ scheduleCarrierRead: async () => ({ owned: false }) }),
    location: { get: async ({ location }: any) => ({ directory: location.directory, project: { id: "project", canonical: repo, directory: repo } }) },
    session: {
      get: async ({ sessionID }: any) => structuredClone(sessions.get(sessionID)),
      list: async () => ({ data: Array.from(sessions.values(), s => structuredClone(s)), cursor: {} }),
      active: async () => ({}),
      move: async ({ sessionID, directory }: any) => {
        moves.push({ id: sessionID, directory })
        sessions.get(sessionID)!.location = { directory }
        // Inject a new child already located at childWt after ses_root moves so only the cardinality check catches it.
        if (sessionID === "ses_root" && directory === childWt) {
          sessions.set("ses_mid_child", midMoveChild)
        }
      },
    },
  }
  const app = Fastify()
  registerWorktreeRoutes(app, {
    worktreeDeletionFence: new WorktreeDeletionFence(),
    workspaceManager: {
      get: () => ({ id: "workspace", path: repo }),
      getWorktrees: () => fixtureCatalogue(repo),
      getServiceLocation: () => ({ directory: repo }),
      getServiceDirectoryForPath: async (_id: string, directory: string) => directory,
      getWorktreeIdentityForPath: async (_id: string, directory: string) => directory,
      getSharedServiceClient: async () => client,
    } as any,
  })
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/workspaces/workspace/sessions/ses_root/worktree",
      payload: { worktreeSlug: entry.slug, branch: "issue-15" },
    })
    assert.equal(response.statusCode, 409, response.body)
    assert.deepEqual(response.json(), { error: "Session family changed during the move" })
    assert.equal(rootSession.location.directory, repo, "root must roll back to its original worktree")
    assert.deepEqual(moves, [
      { id: "ses_root", directory: childWt },
      { id: "ses_root", directory: repo },
    ])
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }) }
})
