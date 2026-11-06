import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

test("native inventory proves checkout absence before falling back, including strict manager reads", async t => {
  const parent = process.platform === "win32" ? path.join(tmpdir(), "opencode") : tmpdir()
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(path.join(parent, "native-worktree-fallback-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repo = path.join(root, "repo"), linked = path.join(root, "linked")
  const nonGit = path.join(root, "non-git"), broken = path.join(root, "broken")
  const emptyPath = path.join(root, "empty-path")
  for (const directory of [nonGit, broken, emptyPath]) await mkdir(directory)
  await writeFile(path.join(broken, ".git"), "invalid pointer\n")
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)))
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "private-gitconfig"), GIT_CONFIG_COUNT: "0" })
  const git = (...args: string[]) => execFileSync("git", args, { env, windowsHide: true, stdio: "pipe" })
  git("init", "--initial-branch=main", repo)
  git("-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "fixture")
  git("-C", repo, "worktree", "add", "--detach", linked)
  const module = (relative: string) => JSON.stringify(new URL(relative, import.meta.url).href)
  const script = `
    import assert from "node:assert/strict"
    import { execFileSync } from "node:child_process"
    import pino from "pino"
    import { listNativeWorktrees } from ${module("../native-worktrees.ts")}
    import { sharesGitCommonDirectory } from ${module("../git-worktrees.ts")}
    import { WorkspaceManager } from ${module("../manager.ts")}
    import { EventBus } from ${module("../../events/bus.ts")}
    const { repo, linked, nonGit, broken } = ${JSON.stringify({ repo, linked, nonGit, broken })}
    const missingGit = process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER !== "1"
    assert.throws(() => execFileSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], { windowsHide: true, stdio: "pipe" }),
      error => missingGit ? error.code === "ENOENT" : /dubious ownership/.test(String(error.stderr)))
    const context = workspacePath => ({ client: {}, workspacePath, location: { directory: workspacePath }, toHost: async directory => directory })
    const expectedError = missingGit ? /Git ownership inventory unavailable/ : /Git checkout discovery failed/
    if (missingGit) {
      for (const folder of [repo, broken]) {
        const inventory = await listNativeWorktrees(context(folder))
        assert.equal(inventory.gitAvailable, false)
        assert.equal(inventory.worktrees[0].directoryOnly, true)
      }
    } else {
      await assert.rejects(listNativeWorktrees(context(repo)), expectedError)
      await assert.rejects(listNativeWorktrees(context(broken)), /Invalid worktree Git directory/)
    }
    assert.deepEqual(await listNativeWorktrees(context(nonGit)), {
      ...(missingGit ? { gitAvailable: false } : { isGitRepo: false }),
      worktrees: [{ slug: "root", directory: nonGit, serviceDirectory: nonGit, kind: "root", ...(missingGit ? { directoryOnly: true } : {}) }],
    })
    assert.equal(await sharesGitCommonDirectory(repo, linked, true), true)
    const manager = new WorkspaceManager({ rootDir: repo,
      settings: { getOwner: () => ({ environmentVariables: {} }) },
      binaryResolver: { resolveDefault: () => ({ path: process.execPath, label: "fixture" }) },
      eventBus: new EventBus(), logger: pino({ level: "silent" }),
      sharedService: { headers: async () => ({}), client: async () => ({}), shutdown: async () => {},
        validateLocation: async location => ({ ...location, project: { id: "fixture", directory: repo, canonical: repo } }) },
    })
    try {
      const { workspace } = await manager.create(repo)
      assert.equal(await manager.ownsLocation(workspace.id, { directory: repo }, undefined, undefined, "request", true), true)
      for (const purpose of ["request", "event"]) for (const strict of [true, false, true]) {
        const ownership = manager.ownsLocation(workspace.id, { directory: linked }, undefined, undefined, purpose, strict)
        if (missingGit && !strict) assert.equal(await ownership, false)
        else await assert.rejects(ownership, expectedError)
      }
    } finally { await manager.shutdown() }
    console.log("PASS " + (missingGit ? "missing Git" : "unsafe-directory rejection"))
  `
  for (const missingGit of [false, true]) {
    const privateEnv = { ...env }
    if (missingGit) {
      for (const key of Object.keys(privateEnv)) if (key.toLowerCase() === "path") delete privateEnv[key]
      privateEnv.PATH = emptyPath
    } else privateEnv.GIT_TEST_ASSUME_DIFFERENT_OWNER = "1"
    const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: privateEnv, windowsHide: true, encoding: "utf8", timeout: 20_000, stdio: "pipe",
    })
    assert.match(output, /PASS/)
    t.diagnostic(output.trim())
  }
})
