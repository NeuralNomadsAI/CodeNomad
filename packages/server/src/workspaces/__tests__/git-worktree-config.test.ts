import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import { fixtureCatalogue } from "./native-worktree-fixture"

const git = (directory: string, ...args: string[]) => execFileSync("git", ["-C", directory, ...args], {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).trim()
const gitPath = (directory: string) => directory.replaceAll("\\", "/")

describe("configured Git checkout roots", () => {
  let temp: string
  let repo: string
  let linked: string
  let redirected: string
  let environment: Record<string, string | undefined>

  beforeEach(() => {
    environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("GIT_")))
    for (const key of Object.keys(environment)) delete process.env[key]
    temp = mkdtempSync(path.join(tmpdir(), "codenomad-checkout-config-"))
    process.env.GIT_CONFIG_NOSYSTEM = "1"
    process.env.GIT_CONFIG_GLOBAL = path.join(temp, "empty-global-config")
    writeFileSync(process.env.GIT_CONFIG_GLOBAL, "")
    repo = path.join(temp, "main repo")
    linked = path.join(temp, "linked checkout")
    redirected = path.join(temp, "effective root")
    git(temp, "init", "--initial-branch=main", repo)
    git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial")
    git(repo, "worktree", "add", "-b", "feature", linked)
    mkdirSync(redirected)
  })

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key]
    Object.assign(process.env, environment)
    rmSync(temp, { recursive: true, force: true })
  })

  for (const mode of ["absolute", "relative"] as const) {
    it(`rejects an administrative backlink redirected by ${mode} configuration`, async () => {
      mkdirSync(path.join(repo, "nested"))
      mkdirSync(path.join(linked, "nested"))
      const workspace = path.join(repo, "nested")
      const before = await fixtureCatalogue(workspace)
      assert.equal(before.worktrees.length, 2)
      assert.equal(before.worktrees.find(entry => entry.kind === "worktree")?.directory, path.join(realpathSync(linked), "nested"))
      const admin = git(linked, "rev-parse", "--absolute-git-dir")
      const backlink = readFileSync(path.join(admin, "gitdir"), "utf8")
      git(repo, "config", "extensions.worktreeConfig", "true")
      git(linked, "config", "--worktree", "core.worktree",
        mode === "absolute" ? redirected : gitPath(path.relative(admin, redirected)))
      assert.equal(realpathSync(git(linked, "rev-parse", "--show-toplevel")), realpathSync(redirected))
      assert.equal(readFileSync(path.join(admin, "gitdir"), "utf8"), backlink)
      await assert.rejects(fixtureCatalogue(workspace), /not a checkout root/)
    })
  }

  it("rejects a linked checkout made bare through worktree config", async () => {
    git(repo, "config", "extensions.worktreeConfig", "true")
    git(linked, "config", "--worktree", "core.bare", "true")
    assert.equal(git(linked, "rev-parse", "--is-bare-repository"), "true")
    await assert.rejects(fixtureCatalogue(repo), /must be run in a work tree/)
  })

  it("checks a redirected main checkout when opened from an ordinary linked checkout", async () => {
    git(repo, "config", "core.worktree", redirected)
    assert.equal(realpathSync(git(repo, "rev-parse", "--show-toplevel")), realpathSync(redirected))
    assert.equal(realpathSync(git(linked, "rev-parse", "--show-toplevel")), realpathSync(linked))
    await assert.rejects(fixtureCatalogue(linked), /not a checkout root/)
  })

  for (const mode of ["worktree", "conditional shared", "conditional global"] as const) {
    it(`uses Git's effective root semantics for ${mode} includes`, async () => {
      const admin = git(linked, "rev-parse", "--absolute-git-dir")
      const included = gitPath(path.join(temp, "root-config"))
      writeFileSync(included, `[core]\n\tworktree = "${gitPath(redirected)}"\n`)
      if (mode === "worktree") {
        git(repo, "config", "extensions.worktreeConfig", "true")
        git(linked, "config", "--worktree", "include.path", included)
      } else {
        git(repo, "config", mode === "conditional global" ? "--global" : "--local",
          `includeIf.gitdir:${gitPath(admin)}.path`, included)
        // The main checkout does not activate this condition.
        assert.throws(() => git(repo, "config", "--get", "core.worktree"))
      }
      assert.equal(git(linked, "config", "--includes", "--get", "core.worktree"), gitPath(redirected))
      // Git's early repository setup can ignore included core.worktree even
      // though `config --get` reports it. Do not emulate that setup in JS.
      const effectiveRoot = realpathSync(git(linked, "rev-parse", "--show-toplevel"))
      if (effectiveRoot === realpathSync(linked)) {
        assert.equal((await fixtureCatalogue(repo)).worktrees.length, 2)
      } else {
        await assert.rejects(fixtureCatalogue(repo), /not a checkout root/)
      }
    })
  }

  it("accepts unredirected worktree configuration and still rejects substituted backlinks", async () => {
    git(repo, "config", "extensions.worktreeConfig", "true")
    git(linked, "config", "--worktree", "core.worktree", linked)
    assert.equal((await fixtureCatalogue(repo)).worktrees.length, 2)
    const other = path.join(temp, "other checkout")
    git(repo, "worktree", "add", "--detach", other)
    rmSync(path.join(linked, ".git"))
    writeFileSync(path.join(linked, ".git"), readFileSync(path.join(other, ".git")))
    await assert.rejects(fixtureCatalogue(repo), /not a checkout root/)
  })

  it("keeps the ordinary scan process count constant with benign includes and more checkouts", async () => {
    const included = path.join(temp, "benign-config")
    writeFileSync(included, "[core]\n\tbare = false\n[user]\n\tname = Test\n")
    git(repo, "config", "include.path", gitPath(included))
    const other = path.join(temp, "detached checkout")
    git(repo, "worktree", "add", "--detach", other)
    const trace = path.join(temp, "git-trace.json")
    process.env.GIT_TRACE2_EVENT = gitPath(trace)
    const scan = async (directories: string[]) => {
      writeFileSync(trace, "")
      const result = await fixtureCatalogue(repo, directories)
      const starts = readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line))
        .filter(event => event.event === "start" && event.argv.some((arg: string) => arg.startsWith(temp)))
      assert.equal(starts.filter(event => event.argv.includes("--porcelain")).length, 1)
      assert.equal(starts.filter(event => event.argv.includes("--includes")).length, 1)
      return { result, commands: starts.map(event => event.argv.slice(3)) }
    }
    const one = await scan([repo])
    const many = await scan([repo, linked, other])
    assert.equal(many.result.worktrees.length, 3)
    assert.deepEqual(many.commands.sort(), one.commands.sort())
    assert.equal(many.result.worktrees.find(entry => entry.branch === "feature")?.removable, true)
  })
})
