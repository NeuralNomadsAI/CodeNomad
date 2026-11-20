import assert from "node:assert/strict"
import { execFile, execFileSync } from "node:child_process"
import { promisify } from "node:util"
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"
import { createWorkItemBranch, lookupWorkItemBranch, readWorkItemBranches, type WorkItemBranchSource } from "./work-item-branches"

const roots: string[] = []
// Results without the tip and repository identity, asserted separately.
const shape = <T extends object>(result: T) => { const { revision: _revision, repository: _repository, ...rest } = result as T & { revision?: string; repository?: string }; return rest }
const create = (...args: Parameters<typeof createWorkItemBranch>) => createWorkItemBranch(...args).then(shape)
const lookup = (...args: Parameters<typeof lookupWorkItemBranch>) => lookupWorkItemBranch(...args).then(shape)
const git = (directory: string, ...args: string[]) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim()
const commit = (directory: string, message: string) => git(directory, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", message)

// Remotes are served over Git's dumb HTTP protocol, so URLs parse as forge repositories.
let server: Server, origin = ""
before(async () => {
  server = createServer((request, response) => {
    const [, root, repository, ...rest] = decodeURIComponent(new URL(request.url!, "http://x").pathname).split("/")
    try { response.end(readFileSync(path.join(tmpdir(), root!, repository!, ...rest))) } catch { response.statusCode = 404; response.end() }
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
after(() => { server.close(); for (const root of roots) rmSync(root, { recursive: true, force: true }) })

/** A clone of `<root>/app.git`, which publishes `refs/pull/7/head` and `refs/merge-requests/8/head` off every branch. */
async function project(label = "") {
  const root = mkdtempSync(path.join(tmpdir(), "codenomad-item-branches-"))
  roots.push(root)
  const work = path.join(root, "work"), bare = path.join(root, "app.git"), clone = path.join(root, "clone")
  git(root, "init", "-q", "-b", "main", work)
  commit(work, "base")
  const base = git(work, "rev-parse", "HEAD")
  commit(work, `contribution ${label}`)
  const head = git(work, "rev-parse", "HEAD")
  git(work, "reset", "-q", "--hard", base)
  git(root, "clone", "-q", "--bare", work, bare)
  git(bare, "update-ref", "refs/pull/7/head", head)
  git(bare, "update-ref", "refs/merge-requests/8/head", head)
  git(bare, "update-server-info")
  const url = `${origin}/${path.basename(root)}/app.git`
  // Asynchronous: the server answering it runs on this event loop.
  await promisify(execFile)("git", ["clone", "-q", url, clone])
  const source: WorkItemBranchSource = { provider: "github", host: new URL(origin).host, path: `${path.basename(root)}/app`, name: "origin" }
  return { root, clone, base, head, source }
}

describe("work item branches", () => {
  it("creates an issue branch from the base checkout's HEAD once, linked to that item of this repository only", async () => {
    const { clone, base, source } = await project()
    const displayed = path.join(clone, "..", "displayed")
    git(clone, "worktree", "add", "-q", "-b", "displayed", displayed, "origin/main")
    commit(displayed, "displayed tip")
    assert.deepEqual(await create(clone, source, "issue", 3, { base: displayed }), { status: "ok", branch: "issue-3", created: true })
    assert.equal(git(clone, "rev-parse", "issue-3"), git(displayed, "rev-parse", "HEAD"), "from the displayed checkout, not the project folder")
    assert.deepEqual(await create(clone, source, "issue", 3), { status: "ok", branch: "issue-3", created: false })
    assert.deepEqual(await create(clone, source, "issue", 4), { status: "ok", branch: "issue-4", created: true })
    assert.equal(git(clone, "rev-parse", "issue-4"), base)
    assert.deepEqual(await readWorkItemBranches(clone, { host: source.host, path: source.path.toUpperCase() }),
      [{ kind: "issue", number: 3, branch: "issue-3" }, { kind: "issue", number: 4, branch: "issue-4" }])
    assert.deepEqual(await readWorkItemBranches(clone, { host: source.host, path: "team/other" }), [])
  })

  it("fetches a pull or merge request head as the repository publishes it, leaving no scratch ref", async () => {
    const { clone, head, source } = await project()
    assert.deepEqual(await create(clone, source, "pullRequest", 7), { status: "ok", branch: "pr-7", created: true })
    assert.equal(git(clone, "rev-parse", "pr-7"), head)
    assert.deepEqual(await createWorkItemBranch(clone, source, "pullRequest", 7), { status: "ok", branch: "pr-7", revision: head, created: false })
    assert.deepEqual(await lookupWorkItemBranch(clone, source, "pullRequest", 7), { status: "ok", repository: `${source.host}/${source.path}`.toLowerCase(), branch: "pr-7" })
    assert.deepEqual(await create(clone, { ...source, provider: "gitlab" }, "pullRequest", 8), { status: "ok", branch: "pr-8", created: true })
    assert.equal(git(clone, "rev-parse", "pr-8"), head)
    assert.equal(git(clone, "for-each-ref", "refs/codenomad/"), "")
    assert.deepEqual((await readWorkItemBranches(clone, source)).map(link => link.branch).sort(), ["pr-7", "pr-8"])
  })

  it("never moves another branch through the remote's configured refspecs", async () => {
    const { clone, base, source } = await project()
    git(clone, "branch", "keep", base)
    git(clone, "config", "--add", "remote.origin.fetch", "+refs/pull/7/head:refs/heads/keep")
    assert.equal((await createWorkItemBranch(clone, source, "pullRequest", 7)).status, "ok")
    assert.equal(git(clone, "rev-parse", "keep"), base)
  })

  it("refuses a remote that no longer names the confirmed repository", async () => {
    const { clone, source } = await project()
    const other = await project()
    git(clone, "remote", "set-url", "origin", git(other.clone, "remote", "get-url", "origin"))
    assert.deepEqual(await create(clone, source, "pullRequest", 7), { status: "unavailable" })
    assert.equal(git(clone, "for-each-ref", "refs/heads/pr-7"), "")
  })

  it("fetches from the URL it validated, rewritten once like the validation", async () => {
    const first = await project("first"), second = await project("second")
    const a = git(first.clone, "remote", "get-url", "origin"), b = git(second.clone, "remote", "get-url", "origin")
    git(first.clone, "remote", "set-url", "origin", "review:app")
    git(first.clone, "config", `url.${a}.insteadOf`, "review:app")
    git(first.clone, "config", `url.${b}.insteadOf`, a)
    assert.equal((await createWorkItemBranch(first.clone, first.source, "pullRequest", 7)).status, "ok")
    assert.equal(git(first.clone, "rev-parse", "pr-7"), first.head)
    assert.notEqual(first.head, second.head)
  })

  it("writes nothing once the guard refuses, even after the fetch", async () => {
    const { clone, source } = await project()
    let checks = 0
    const refused = () => { if (++checks === 2) throw new Error("revoked") }
    await assert.rejects(createWorkItemBranch(clone, source, "pullRequest", 7, { check: async () => refused() }), /revoked/)
    await assert.rejects(createWorkItemBranch(clone, source, "issue", 3, { check: async () => { throw new Error("revoked") } }), /revoked/)
    assert.equal(git(clone, "for-each-ref", "refs/heads/pr-7", "refs/heads/issue-3", "refs/codenomad/"), "")
  })

  it("never takes over an unlinked branch of the same name, and reports a missing head", async () => {
    const { clone, base, source } = await project()
    git(clone, "branch", "pr-7", base)
    assert.deepEqual(await create(clone, source, "pullRequest", 7), { status: "conflict", branch: "pr-7" })
    assert.equal(git(clone, "rev-parse", "pr-7"), base)
    assert.deepEqual(await create(clone, source, "pullRequest", 9), { status: "unavailable" })
    assert.equal(git(clone, "for-each-ref", "refs/heads/pr-9", "refs/codenomad/"), "")
  })

  it("keeps a linked branch the user advanced, but never relinks a name recreated after its ref was deleted", async () => {
    const { clone, source } = await project()
    assert.equal((await createWorkItemBranch(clone, source, "issue", 7)).status, "ok")
    git(clone, "switch", "-q", "issue-7"); commit(clone, "work"); git(clone, "switch", "-q", "main")
    assert.deepEqual(await lookup(clone, source, "issue", 7), { status: "ok", branch: "issue-7" })
    git(clone, "update-ref", "-d", "refs/heads/issue-7")
    commit(clone, "unrelated")
    git(clone, "branch", "issue-7")
    assert.deepEqual(await lookup(clone, source, "issue", 7), { status: "conflict", branch: "issue-7" })
    assert.deepEqual(await create(clone, source, "issue", 7), { status: "conflict", branch: "issue-7" })
  })

  it("revalidates the repository before an issue branch is created or reused", async () => {
    const { clone, source } = await project()
    assert.equal((await createWorkItemBranch(clone, source, "issue", 5)).status, "ok")
    git(clone, "remote", "set-url", "origin", "https://github.com/team/new.git")
    assert.deepEqual(await create(clone, source, "issue", 6), { status: "unavailable" })
    assert.deepEqual(await create(clone, source, "issue", 5), { status: "unavailable" })
    assert.deepEqual(await lookup(clone, source, "issue", 5), { status: "unavailable" })
    assert.equal(git(clone, "for-each-ref", "refs/heads/issue-6"), "")
  })

  it("an exact lookup sees links beyond the listing's 200", async () => {
    const { clone, base, source } = await project()
    const value = (i: number) => `${source.host}/${source.path}#issue/${i}@${base}`.toLowerCase()
    execFileSync("git", ["-C", clone, "update-ref", "--stdin"], { input: Array.from({ length: 201 }, (_, i) => `create refs/heads/issue-${i + 1} ${base}\n`).join("") })
    appendFileSync(path.join(clone, ".git", "config"), Array.from({ length: 201 }, (_, i) => `\n[branch "issue-${i + 1}"]\n\tcodenomad-work-item = \"${value(i + 1)}\"\n`).join(""))
    assert.equal((await readWorkItemBranches(clone, source)).length, 200)
    assert.deepEqual(await lookup(clone, source, "issue", 201), { status: "ok", branch: "issue-201" })
  })

  it("finds the item's link however many others exist, and forgets links whose branch is gone", async () => {
    const { clone, base, source } = await project()
    execFileSync("git", ["-C", clone, "update-ref", "--stdin"], { input: Array.from({ length: 250 }, (_, i) => `create refs/heads/old-${i} ${base}\n`).join("") })
    appendFileSync(path.join(clone, ".git", "config"), Array.from({ length: 250 }, (_, i) => `\n[branch "old-${i}"]\n\tcodenomad-work-item = \"github.com/o/old#issue/${i + 1}\"\n`).join(""))
    assert.equal((await createWorkItemBranch(clone, source, "issue", 201)).status, "ok")
    assert.deepEqual(await readWorkItemBranches(clone, source), [{ kind: "issue", number: 201, branch: "issue-201" }])
    assert.deepEqual(await create(clone, source, "issue", 201), { status: "ok", branch: "issue-201", created: false })
    git(clone, "update-ref", "-d", "refs/heads/issue-201")
    assert.deepEqual(await readWorkItemBranches(clone, source), [])
  })
})
