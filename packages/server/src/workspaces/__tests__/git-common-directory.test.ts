import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import { readGitCommonDirectory } from "../git-common-directory"
import { sharesGitCommonDirectory } from "../git-worktrees"
import { runGitProcess } from "../git-process"

const git = (directory: string, ...args: string[]) => execFileSync("git", ["-C", directory, ...args], {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
}).trim()

describe("Git ownership preflight admission", () => {
  let temp: string
  let repo: string
  let linked: string
  let trace: string
  let environment: Record<string, string | undefined>

  beforeEach(() => {
    environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("GIT_")))
    for (const key of Object.keys(environment)) delete process.env[key]
    temp = mkdtempSync(path.join(tmpdir(), "codenomad-git-preflight-"))
    process.env.GIT_CONFIG_NOSYSTEM = "1"
    process.env.GIT_CONFIG_GLOBAL = path.join(temp, "empty-global-config")
    writeFileSync(process.env.GIT_CONFIG_GLOBAL, "")
    repo = path.join(temp, "main repo")
    linked = path.join(temp, "linked checkout")
    git(temp, "init", "--initial-branch=main", repo)
    git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial")
    git(repo, "worktree", "add", "-b", "feature", linked)
    trace = path.join(temp, "trace.json")
    process.env.GIT_TRACE2_EVENT = trace.replaceAll("\\", "/")
  })

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key]
    Object.assign(process.env, environment)
    rmSync(temp, { recursive: true, force: true })
  })

  const events = (file: string) => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : []
  // Ceiling directories make the administrative-file walk defer to Git without changing its answer.
  const forceGit = () => { process.env.GIT_CEILING_DIRECTORIES = path.join(temp, "unrelated-ceiling") }

  it("resolves checkouts and nested directories from administrative files, matching Git without a process", async () => {
    const nested = path.join(linked, "packages", "server")
    mkdirSync(nested, { recursive: true })
    const submodule = path.join(temp, "submodule checkout")
    mkdirSync(submodule)
    writeFileSync(path.join(submodule, ".git"), `gitdir: ${path.relative(submodule, path.join(repo, ".git")).replaceAll("\\", "/")}\n`)
    const directories = [repo, linked, nested, submodule]
    const expected = directories.map(directory => realpathSync(git(directory, "rev-parse", "--path-format=absolute", "--git-common-dir")))
    writeFileSync(trace, "")
    const reads = Array.from({ length: 48 }, () => sharesGitCommonDirectory(repo, nested))
    assert.deepEqual(await Promise.all(reads), Array(48).fill(true))
    assert.deepEqual(await Promise.all(directories.map(readGitCommonDirectory)), expected)
    assert.equal(events(trace).filter(event => event.event === "start").length, 0)
  })

  it("leaves nested bare and separate Git directories to Git as independent repositories", async () => {
    const bare = path.join(repo, "vendor", "lib.git")
    git(temp, "clone", "--quiet", "--bare", repo, bare)
    const separate = path.join(repo, "gitdata")
    git(temp, "init", "--quiet", "--separate-git-dir", separate, path.join(temp, "separate checkout"))
    for (const directory of [bare, path.join(bare, "hooks"), separate]) {
      assert.equal(await readGitCommonDirectory(directory), realpathSync(git(directory, "rev-parse", "--path-format=absolute", "--git-common-dir")), directory)
    }
    assert.equal(await sharesGitCommonDirectory(repo, bare), false)
    assert.equal(await sharesGitCommonDirectory(repo, separate), false)
  })

  it("leaves committed HEAD/commondir Git directories and incomplete .git layouts to Git", async () => {
    const other = path.join(temp, "other repo")
    git(temp, "init", "--quiet", other)
    const pseudo = path.join(repo, "vendor", "pseudo")
    mkdirSync(path.join(pseudo, "nested"), { recursive: true })
    writeFileSync(path.join(pseudo, "HEAD"), "ref: refs/heads/main\n")
    writeFileSync(path.join(pseudo, "commondir"), `${path.relative(pseudo, path.join(other, ".git")).replaceAll("\\", "/")}\n`)
    const incomplete = path.join(repo, "incomplete")
    mkdirSync(path.join(incomplete, ".git", "objects"), { recursive: true })
    writeFileSync(path.join(incomplete, ".git", "HEAD"), "ref: refs/heads/main\n")
    for (const directory of [pseudo, path.join(pseudo, "nested"), incomplete]) {
      assert.equal(await readGitCommonDirectory(directory), realpathSync(git(directory, "rev-parse", "--path-format=absolute", "--git-common-dir")), directory)
    }
    assert.equal(await sharesGitCommonDirectory(repo, pseudo), false)
    assert.equal(await sharesGitCommonDirectory(repo, path.join(pseudo, "nested")), false)
  })

  it("defers environment overrides, paths inside Git directories and invalid layouts to Git", async () => {
    const internal = path.join(repo, ".git", "refs")
    assert.equal(await readGitCommonDirectory(internal), realpathSync(git(internal, "rev-parse", "--path-format=absolute", "--git-common-dir")))
    const broken = path.join(temp, "broken checkout")
    mkdirSync(path.join(broken, ".git"), { recursive: true })
    await assert.rejects(readGitCommonDirectory(broken))
    writeFileSync(trace, "")
    process.env.GIT_DIR = path.join(repo, ".git")
    assert.equal(await readGitCommonDirectory(linked), realpathSync(path.join(repo, ".git")))
    assert.equal(events(trace).filter(event => event.event === "start").length, 1)
  })

  it("coalesces a concurrent Git fallback fan into one command per directory", async () => {
    forceGit()
    const reads = Array.from({ length: 48 }, () => sharesGitCommonDirectory(repo, linked))
    assert.deepEqual(await Promise.all(reads), Array(48).fill(true))
    const starts = events(trace).filter(event => event.event === "start")
    assert.equal(starts.length, 2)
    assert.deepEqual(starts.map(event => event.argv[2]).sort(), [repo, linked].sort())
  })

  it("bounds distinct Git processes without holding the calling event loop", async () => {
    const directories = Array.from({ length: 10 }, (_, index) => path.join(temp, `repo-${index}`))
    for (const directory of directories) git(temp, "init", directory)
    writeFileSync(trace, "")
    forceGit()
    const reads = directories.map(readGitCommonDirectory)
    let settled = false
    void Promise.all(reads).then(() => { settled = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(settled, false)
    assert.deepEqual(await Promise.all(reads), directories.map(directory => realpathSync(path.join(directory, ".git"))))
    const timeline = events(trace).filter(event => event.event === "start" || event.event === "exit")
      .sort((a, b) => a.time.localeCompare(b.time))
    let running = 0
    let starts = 0
    for (const event of timeline) {
      running += event.event === "start" ? 1 : -1
      if (event.event === "start") starts += 1
      assert.ok(running >= 0 && running <= 2, `concurrent Git processes: ${running}`)
    }
    assert.equal(starts, directories.length)
    assert.equal(running, 0)
  })

  it("rechecks changed Git identity and does not retain failed reads", async () => {
    assert.equal(await sharesGitCommonDirectory(repo, linked), true)
    const other = path.join(temp, "independent clone")
    git(temp, "clone", repo, other)
    rmSync(path.join(linked, ".git"))
    writeFileSync(path.join(linked, ".git"), `gitdir: ${path.join(other, ".git").replaceAll("\\", "/")}\n`)
    assert.equal(await sharesGitCommonDirectory(repo, linked), false)
    const missing = path.join(temp, "not-yet-created")
    await assert.rejects(readGitCommonDirectory(missing))
    git(temp, "init", missing)
    assert.equal(await readGitCommonDirectory(missing), realpathSync(path.join(missing, ".git")))
  })

  it("admits a newly selected worktree before the pending Git display batch", async () => {
    forceGit()
    const blockers = Array.from({ length: 2 }, () => runGitProcess(repo, ["-c", "alias.pause=!sleep 0.2", "pause"]))
    const display = Array.from({ length: 24 }, () => runGitProcess(repo, ["diff", "--numstat"]))
    const ownership = readGitCommonDirectory(linked)
    await Promise.all([...blockers, ...display, ownership])
    const starts = events(trace).filter(event => event.event === "start")
    const foregroundIndex = starts.findIndex(event => event.argv.includes("--git-common-dir"))
    const lastDisplayIndex = starts.map(event => event.argv.includes("--numstat")).lastIndexOf(true)
    assert.ok(foregroundIndex >= 0 && foregroundIndex < lastDisplayIndex,
      `ownership at ${foregroundIndex} waited behind all display reads (last at ${lastDisplayIndex})`)
  })
})
