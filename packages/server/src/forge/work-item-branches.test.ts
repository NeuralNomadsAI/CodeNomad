import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import { createWorkItemBranch, readWorkItemBranches, type WorkItemBranchSource } from "./work-item-branches"

const roots: string[] = []
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })
const git = (directory: string, ...args: string[]) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim()

/** A clone whose `origin` publishes `refs/pull/7/head` and `refs/merge-requests/8/head` off every branch. */
function project() {
  const root = mkdtempSync(path.join(tmpdir(), "codenomad-item-branches-"))
  roots.push(root)
  const remote = path.join(root, "remote"), clone = path.join(root, "clone")
  git(root, "init", "-q", "-b", "main", remote)
  for (const [name, value] of [["user.name", "T"], ["user.email", "t@example.com"]]) git(remote, "config", name, value)
  git(remote, "commit", "-q", "--allow-empty", "-m", "base")
  const base = git(remote, "rev-parse", "HEAD")
  git(remote, "commit", "-q", "--allow-empty", "-m", "contribution")
  const head = git(remote, "rev-parse", "HEAD")
  git(remote, "update-ref", "refs/pull/7/head", head)
  git(remote, "update-ref", "refs/merge-requests/8/head", head)
  git(remote, "reset", "-q", "--hard", base)
  git(root, "clone", "-q", remote, clone)
  return { clone, base, head }
}

const github: WorkItemBranchSource = { provider: "github", host: "github.com", path: "Team/App", name: "origin" }

describe("work item branches", () => {
  it("creates an issue branch from HEAD once, linked to that item of this repository only", async () => {
    const { clone, base } = project()
    assert.deepEqual(await createWorkItemBranch(clone, github, "issue", 3), { status: "ok", branch: "issue-3", created: true })
    assert.equal(git(clone, "rev-parse", "issue-3"), base)
    assert.deepEqual(await createWorkItemBranch(clone, github, "issue", 3), { status: "ok", branch: "issue-3", created: false })
    assert.deepEqual(await readWorkItemBranches(clone, { host: "github.com", path: "team/app" }), [{ kind: "issue", number: 3, branch: "issue-3" }])
    assert.deepEqual(await readWorkItemBranches(clone, { host: "github.com", path: "team/other" }), [])
  })

  it("fetches a pull or merge request head as the repository publishes it, leaving no scratch ref", async () => {
    const { clone, head } = project()
    assert.deepEqual(await createWorkItemBranch(clone, github, "pullRequest", 7), { status: "ok", branch: "pr-7", created: true })
    assert.equal(git(clone, "rev-parse", "pr-7"), head)
    assert.deepEqual(await createWorkItemBranch(clone, { ...github, provider: "gitlab" }, "pullRequest", 8), { status: "ok", branch: "pr-8", created: true })
    assert.equal(git(clone, "rev-parse", "pr-8"), head)
    assert.equal(git(clone, "for-each-ref", "refs/codenomad/"), "")
    assert.deepEqual((await readWorkItemBranches(clone, github)).map(link => link.branch).sort(), ["pr-7", "pr-8"])
  })

  it("never takes over an unlinked branch of the same name, and reports a missing head", async () => {
    const { clone, base } = project()
    git(clone, "branch", "pr-7", base)
    assert.deepEqual(await createWorkItemBranch(clone, github, "pullRequest", 7), { status: "conflict", branch: "pr-7" })
    assert.equal(git(clone, "rev-parse", "pr-7"), base)
    assert.deepEqual(await createWorkItemBranch(clone, github, "pullRequest", 9), { status: "unavailable" })
    assert.equal(git(clone, "for-each-ref", "refs/heads/pr-9", "refs/codenomad/"), "")
  })

  it("forgets a link whose branch is gone, even when Git kept its config", async () => {
    const { clone } = project()
    await createWorkItemBranch(clone, github, "issue", 4)
    git(clone, "update-ref", "-d", "refs/heads/issue-4")
    assert.deepEqual(await readWorkItemBranches(clone, github), [])
  })
})
