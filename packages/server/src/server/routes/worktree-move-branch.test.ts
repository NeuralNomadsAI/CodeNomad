import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import Fastify from "fastify"
import { registerWorktreeRoutes } from "./worktrees"
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
