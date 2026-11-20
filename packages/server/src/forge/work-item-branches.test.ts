import assert from "node:assert/strict"
import { execFile, execFileSync, spawnSync } from "node:child_process"
import { promisify } from "node:util"
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"
import { createWorkItemBranch, lookupWorkItemBranch, readWorkItemBranches, type WorkItemBranchSource } from "./work-item-branches"
import { runWorktreeGit } from "../workspaces/git-process"

const roots: string[] = []
// Results without the tip and repository identity, asserted separately.
const shape = <T extends object>(result: T) => { const { revision: _revision, repository: _repository, ...rest } = result as T & { revision?: string; repository?: string }; return rest }
const create = (...args: Parameters<typeof createWorkItemBranch>) => createWorkItemBranch(...args).then(shape)
const lookup = (...args: Parameters<typeof lookupWorkItemBranch>) => lookupWorkItemBranch(...args).then(shape)
const git = (directory: string, ...args: string[]) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim()
const commit = (directory: string, message: string) => git(directory, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", message)

// Remotes are served over Git's dumb HTTP protocol, so URLs parse as forge repositories.
let server: Server, origin = ""
const held: import("node:http").ServerResponse[] = [], closed = new Set<import("node:http").ServerResponse>()
before(async () => {
  server = createServer((request, response) => {
    const [, root, repository, ...rest] = decodeURIComponent(new URL(request.url!, "http://x").pathname).split("/")
    // `/hang/…` never answers, as a stalled forge.
    if (root === "hang") { held.push(response); response.on("close", () => { closed.add(response) }); return }
    try { response.end(readFileSync(path.join(tmpdir(), root!, repository!, ...rest))) } catch { response.statusCode = 404; response.end() }
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
after(() => { for (const response of held) response.destroy(); server.close(); for (const root of roots) rmSync(root, { recursive: true, force: true }) })

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
    assert.deepEqual(await readWorkItemBranches(clone, { ...source, host: source.host.toUpperCase() }),
      [{ kind: "issue", number: 3, branch: "issue-3" }, { kind: "issue", number: 4, branch: "issue-4" }])
    assert.equal(await readWorkItemBranches(clone, { ...source, path: source.path.toUpperCase() }), undefined, "the path keeps its case")
    assert.equal(await readWorkItemBranches(clone, { ...source, path: "team/other" }), undefined)
    git(clone, "remote", "set-url", "origin", "https://github.com/team/new.git")
    assert.equal(await readWorkItemBranches(clone, source), undefined, "a retargeted remote lists nothing of the old repository")
  })

  it("fetches a pull or merge request head as the repository publishes it, leaving no scratch ref", async () => {
    const { clone, head, source } = await project()
    assert.deepEqual(await create(clone, source, "pullRequest", 7), { status: "ok", branch: "pr-7", created: true })
    assert.equal(git(clone, "rev-parse", "pr-7"), head)
    assert.deepEqual(await createWorkItemBranch(clone, source, "pullRequest", 7), { status: "ok", branch: "pr-7", revision: head, created: false })
    assert.deepEqual(await lookupWorkItemBranch(clone, source, "pullRequest", 7), { status: "ok", repository: `${source.host}/${source.path}`, branch: "pr-7" })
    assert.deepEqual(await create(clone, { ...source, provider: "gitlab" }, "pullRequest", 8), { status: "ok", branch: "pr-8", created: true })
    assert.equal(git(clone, "rev-parse", "pr-8"), head)
    assert.equal(git(clone, "for-each-ref", "refs/codenomad/"), "")
    assert.deepEqual((await readWorkItemBranches(clone, source))!.map(link => link.branch).sort(), ["pr-7", "pr-8"])
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
    assert.deepEqual(await create(clone, source, "pullRequest", 7), { status: "changed" })
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

  it("revalidates the repository at the last check before writing", async () => {
    const { clone, source } = await project()
    let checks = 0
    const retarget = async () => { if (++checks === 2) git(clone, "remote", "set-url", "origin", "https://github.com/o/other.git") }
    assert.deepEqual(await create(clone, source, "issue", 15, { check: retarget }), { status: "changed" })
    assert.equal(git(clone, "for-each-ref", "refs/heads/issue-15"), "")
  })

  it("undoes the write when consent is withdrawn while the last checks run", async () => {
    const { clone, source } = await project()
    let checks = 0
    // The third check runs after the write: consent was withdrawn during the final remote check.
    await assert.rejects(create(clone, source, "issue", 16, { check: async () => { if (++checks === 3) throw new Error("revoked") } }), /revoked/)
    assert.equal(git(clone, "for-each-ref", "refs/heads/issue-16"), "")
    assert.equal(git(clone, "config", "--list", "--local").includes("branch.issue-16."), false, "nor its link")
  })

  it("an undone write keeps a branch the user adopted meanwhile, removing only the link", async () => {
    const { clone, source } = await project()
    const adopted = path.join(clone, "..", "adopted")
    let checks = 0
    const check = async () => {
      if (++checks < 3) return
      git(clone, "worktree", "add", "-q", adopted, "issue-19")
      git(clone, "config", "branch.issue-19.description", "mine")
      throw new Error("revoked")
    }
    await assert.rejects(create(clone, source, "issue", 19, { check }), /revoked/)
    assert.equal(git(adopted, "branch", "--show-current"), "issue-19")
    assert.equal(git(adopted, "rev-parse", "HEAD"), git(clone, "rev-parse", "main"), "the checkout keeps its commit")
    assert.equal(git(clone, "config", "branch.issue-19.description"), "mine")
    assert.equal(git(clone, "config", "--list", "--local").includes("codenomad-work-item"), false)
  })

  it("a name recreated by a fetch is not CodeNomad's branch either: only its own reflog marker proves it", async () => {
    const { clone, source } = await project()
    assert.equal((await createWorkItemBranch(clone, source, "issue", 20)).status, "ok")
    git(clone, "update-ref", "-d", "refs/heads/issue-20")
    commit(clone, "unrelated main work")
    git(clone, "fetch", "-q", ".", "refs/heads/main:refs/heads/issue-20")
    assert.deepEqual(await lookup(clone, source, "issue", 20), { status: "conflict", branch: "issue-20" })
  })

  it("never creates a branch that differs from an existing one only by case", async () => {
    const { clone, source } = await project()
    git(clone, "switch", "-q", "-c", "Issue-42"); commit(clone, "unmerged work"); git(clone, "switch", "-q", "main")
    const tip = git(clone, "rev-parse", "refs/heads/Issue-42")
    git(clone, "pack-refs", "--all")
    assert.deepEqual(await lookup(clone, source, "issue", 42), { status: "conflict", branch: "Issue-42" })
    assert.deepEqual(await create(clone, source, "issue", 42), { status: "conflict", branch: "Issue-42" })
    assert.deepEqual(git(clone, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/").split("\n").filter(line => /issue-42/i.test(line)),
      [`refs/heads/Issue-42 ${tip}`])
  })

  it("keeps a pull request branch the user rebased", async () => {
    const { clone, source } = await project()
    assert.equal((await createWorkItemBranch(clone, source, "pullRequest", 7)).status, "ok")
    commit(clone, "main moves on")
    git(clone, "switch", "-q", "pr-7")
    git(clone, "-c", "user.name=T", "-c", "user.email=t@example.com", "rebase", "-q", "main")
    git(clone, "switch", "-q", "main")
    assert.deepEqual(await lookup(clone, source, "pullRequest", 7), { status: "ok", branch: "pr-7" })
  })

  // `--ref-format` needs Git 2.45 (Ubuntu 24.04 ships 2.43).
  const reftable = spawnSync("git", ["clone", "-h"], { encoding: "utf8" }).stdout.includes("ref-format")
  it("keeps a rebased branch in a reftable repository, whose reflogs are not files", { skip: !reftable && "Git without --ref-format" }, async () => {
    const { root, clone, source } = await project()
    const reftable = path.join(root, "reftable")
    await promisify(execFile)("git", ["clone", "-q", "--ref-format=reftable", git(clone, "remote", "get-url", "origin"), reftable])
    assert.equal(git(reftable, "rev-parse", "--show-ref-format"), "reftable")
    assert.equal((await createWorkItemBranch(reftable, source, "pullRequest", 7)).status, "ok")
    commit(reftable, "main moves on")
    git(reftable, "-c", "user.name=T", "-c", "user.email=t@example.com", "rebase", "-q", "main", "pr-7")
    git(reftable, "switch", "-q", "main")
    assert.deepEqual(await lookup(reftable, source, "pullRequest", 7), { status: "ok", branch: "pr-7" })
  })

  it("keeps a link whose creation entry expired from a reflog that goes on", async () => {
    const { clone, source } = await project()
    assert.equal((await createWorkItemBranch(clone, source, "issue", 43)).status, "ok")
    await new Promise(resolve => setTimeout(resolve, 1_100))
    git(clone, "switch", "-q", "issue-43"); commit(clone, "work"); git(clone, "switch", "-q", "main")
    git(clone, "reflog", "expire", `--expire=${git(clone, "log", "-1", "--format=%ct", "issue-43")}`, "refs/heads/issue-43")
    assert.equal(git(clone, "reflog", "show", "--format=%gs", "refs/heads/issue-43"), "commit: work")
    assert.deepEqual(await lookup(clone, source, "issue", 43), { status: "ok", branch: "issue-43" })
  })

  it("follows the remote Git selects now: an upstream added after discovery is a change", async () => {
    const { clone, source } = await project()
    git(clone, "remote", "add", "upstream", "https://github.com/parent/repo.git")
    assert.deepEqual(await create(clone, source, "issue", 17), { status: "changed" })
    assert.deepEqual(await create(clone, source, "pullRequest", 7), { status: "changed" })
    assert.equal(git(clone, "for-each-ref", "refs/heads/issue-17", "refs/heads/pr-7"), "")
  })

  it("a name recreated by hand at the start commit, then advanced, is not CodeNomad's branch", async () => {
    const { clone, base, source } = await project()
    assert.equal((await createWorkItemBranch(clone, source, "issue", 18)).status, "ok")
    git(clone, "update-ref", "-d", "refs/heads/issue-18")
    git(clone, "branch", "issue-18", base)
    git(clone, "switch", "-q", "issue-18"); commit(clone, "someone else's work"); git(clone, "switch", "-q", "main")
    assert.deepEqual(await lookup(clone, source, "issue", 18), { status: "conflict", branch: "issue-18" })
  })

  it("a stalled pull request fetch neither holds the shared Git worker nor outlives its caller", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "codenomad-item-branches-hang-"))
    roots.push(root)
    git(root, "init", "-q", "-b", "main", path.join(root, "repo"))
    const repo = path.join(root, "repo")
    commit(repo, "base")
    git(repo, "remote", "add", "origin", `${origin}/hang/app.git`)
    const source: WorkItemBranchSource = { provider: "github", host: new URL(origin).host, path: "hang/app", name: "origin" }
    const controllers = [new AbortController(), new AbortController()]
    const before = held.length
    const pending = controllers.map(controller => createWorkItemBranch(repo, source, "pullRequest", 7, { signal: controller.signal }).catch(error => error))
    while (held.length < before + 1) await new Promise(resolve => setTimeout(resolve, 20))
    const read = await Promise.race([runWorktreeGit(repo, ["rev-parse", "HEAD"]).then(() => "read"),
      new Promise(resolve => setTimeout(() => resolve("queued"), 2_000))])
    assert.equal(read, "read", "local reads keep their worker slots during a fetch")
    for (const controller of controllers) controller.abort(new Error("gone"))
    const settled = await Promise.race([Promise.all(pending).then(() => "settled"), new Promise(resolve => setTimeout(() => resolve("running"), 12_000))])
    assert.equal(settled, "settled", "an abandoned fetch stops")
    // The whole process tree ends: the transport helper's connection closes too.
    for (let attempt = 0; attempt < 60 && held.slice(before).some(response => !closed.has(response)); attempt++) await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(held.slice(before).every(response => closed.has(response)), true, "the forge connection is closed")
    assert.equal(git(repo, "for-each-ref", "refs/heads/pr-7", "refs/codenomad/"), "")
  })

  it("tells repositories apart by path case, which self-hosted forges may distinguish", async () => {
    const { clone, source } = await project()
    git(clone, "remote", "set-url", "origin", git(clone, "remote", "get-url", "origin").replace(source.path, source.path.toUpperCase()))
    assert.deepEqual(await create(clone, source, "issue", 8), { status: "changed" })
    assert.equal(git(clone, "for-each-ref", "refs/heads/issue-8"), "")
  })

  it("fetches through an insteadOf alias that is also another remote's name", async () => {
    const first = await project("alias-first"), second = await project("alias-second")
    const a = git(first.clone, "remote", "get-url", "origin")
    git(first.clone, "remote", "set-url", "origin", "alias")
    git(first.clone, "remote", "add", "alias", git(second.clone, "remote", "get-url", "origin"))
    git(first.clone, "config", `url.${a}.insteadOf`, "alias")
    assert.equal((await createWorkItemBranch(first.clone, first.source, "pullRequest", 7)).status, "ok")
    assert.equal(git(first.clone, "rev-parse", "pr-7"), first.head)
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
    assert.deepEqual(await lookup(clone, source, "pullRequest", 7), { status: "conflict", branch: "pr-7" }, "reported before any dialog")
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

  it("a copied or renamed branch never inherits the link", async () => {
    const { clone, source } = await project()
    assert.equal((await createWorkItemBranch(clone, source, "issue", 7)).status, "ok")
    git(clone, "branch", "-c", "issue-7", "backup")
    git(clone, "branch", "-D", "issue-7")
    git(clone, "branch", "-m", "backup", "renamed")
    assert.deepEqual(await readWorkItemBranches(clone, source), [])
    assert.deepEqual(await lookup(clone, source, "issue", 7), { status: "ok", branch: null })
  })

  it("a copy renamed back to the item's name is not its branch, though Git carried the marker along", async () => {
    const { clone, source } = await project()
    assert.equal((await createWorkItemBranch(clone, source, "issue", 44)).status, "ok")
    git(clone, "branch", "-c", "issue-44", "backup")
    git(clone, "switch", "-q", "backup"); commit(clone, "other work"); git(clone, "switch", "-q", "main")
    git(clone, "branch", "-D", "issue-44")
    git(clone, "branch", "-m", "backup", "issue-44")
    assert.deepEqual(await lookup(clone, source, "issue", 44), { status: "conflict", branch: "issue-44" })
  })

  it("revalidates the repository before an issue branch is created or reused", async () => {
    const { clone, source } = await project()
    assert.equal((await createWorkItemBranch(clone, source, "issue", 5)).status, "ok")
    git(clone, "remote", "set-url", "origin", "https://github.com/team/new.git")
    assert.deepEqual(await create(clone, source, "issue", 6), { status: "changed" })
    assert.deepEqual(await create(clone, source, "issue", 5), { status: "changed" })
    assert.deepEqual(await lookup(clone, source, "issue", 5), { status: "unavailable" })
    assert.equal(git(clone, "for-each-ref", "refs/heads/issue-6"), "")
  })

  it("an exact lookup sees links beyond the listing's 200", async () => {
    const { clone, base, source } = await project()
    const value = (i: number) => `${source.host}/${source.path}#issue/${i}@${base}/issue-${i}`
    execFileSync("git", ["-C", clone, "update-ref", "-m", "codenomad: work item issue/201", "--stdin"], { input: Array.from({ length: 201 }, (_, i) => `create refs/heads/issue-${i + 1} ${base}\n`).join("") })
    appendFileSync(path.join(clone, ".git", "config"), Array.from({ length: 201 }, (_, i) => `\n[branch "issue-${i + 1}"]\n\tcodenomad-work-item = \"${value(i + 1)}\"\n`).join(""))
    assert.equal((await readWorkItemBranches(clone, source))!.length, 200)
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
