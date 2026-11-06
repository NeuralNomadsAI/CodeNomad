import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

test("native inventory preserves root fallback while strict readers reject unverified discovery, including cached reads", async t => {
  const parent = process.platform === "win32" ? path.join(tmpdir(), "opencode") : tmpdir()
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(path.join(parent, "native-worktree-fallback-"))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const repo = path.join(root, "repo"), linked = path.join(root, "linked")
  const nonGit = path.join(root, "non-git"), broken = path.join(root, "broken")
  const marker = path.join(root, "marker"), missingAdmin = path.join(root, "missing-admin")
  const nested = path.join(repo, "nested")
  const emptyPath = path.join(root, "empty-path")
  for (const directory of [nonGit, broken, marker, missingAdmin, emptyPath]) await mkdir(directory)
  await writeFile(path.join(broken, ".git"), "invalid pointer\n")
  await writeFile(path.join(marker, "HEAD"), "stray marker\n")
  await writeFile(path.join(missingAdmin, ".git"), "gitdir: missing\n")
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)))
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "private-gitconfig"), GIT_CONFIG_COUNT: "0" })
  const git = (...args: string[]) => execFileSync("git", args, { env, windowsHide: true, stdio: "pipe" })
  git("init", "--initial-branch=main", repo)
  git("-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "fixture")
  git("-C", repo, "worktree", "add", "--detach", linked)
  await mkdir(nested)
  const module = (relative: string) => JSON.stringify(new URL(relative, import.meta.url).href)
  const script = `
    import assert from "node:assert/strict"
    import { execFileSync } from "node:child_process"
    import pino from "pino"
    import { listNativeWorktrees } from ${module("../native-worktrees.ts")}
    import { sharesGitCommonDirectory } from ${module("../git-worktrees.ts")}
    import { WorkspaceManager } from ${module("../manager.ts")}
    import { EventBus } from ${module("../../events/bus.ts")}
    import { resolveOwnedWorktreePath, invalidateWorktreeCache } from ${module("../worktree-directory.ts")}
    const { repo, linked, nonGit, broken, marker, missingAdmin, nested } = ${JSON.stringify({ repo, linked, nonGit, broken, marker, missingAdmin, nested })}
    const ceiling = Boolean(process.env.GIT_CEILING_DIRECTORIES)
    const missingGit = !ceiling && process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER !== "1"
    assert.throws(() => execFileSync("git", ["-C", ceiling ? nested : repo, "rev-parse", "--show-toplevel"], { windowsHide: true, stdio: "pipe" }),
      error => missingGit ? error.code === "ENOENT" : ceiling ? /not a git repository/.test(String(error.stderr)) : /dubious ownership/.test(String(error.stderr)))
    const context = workspacePath => ({ client: {}, workspacePath, location: { directory: workspacePath }, toHost: async directory => directory })
    const expectedError = /Git ownership inventory unavailable/
    for (const folder of [ceiling ? nested : repo, broken, marker, missingAdmin]) {
      const inventory = await listNativeWorktrees(context(folder))
      assert.deepEqual(inventory, {
        ...(missingGit ? { gitAvailable: false } : { isGitRepo: false }),
        worktrees: [{ slug: "root", directory: folder, serviceDirectory: folder, kind: "root",
          ...(missingGit ? { directoryOnly: true } : {}) }],
      })
      let reads = 0
      const params = { workspaceId: folder, workspacePath: folder, directory: folder,
        loadWorktrees: async () => { reads++; return inventory.worktrees } }
      assert.equal((await resolveOwnedWorktreePath(params)).slug, "root")
      for (let i = 0; i < 2; i++) await assert.rejects(resolveOwnedWorktreePath({ ...params, strict: true }), expectedError)
      assert.equal(reads, 1, "strict readers qualify cached fallback without changing the public inventory")
      if (folder === (ceiling ? nested : repo)) {
        assert.equal(Boolean(await resolveOwnedWorktreePath({ ...params, directory: folder + "/child" })), !missingGit)
      }
      invalidateWorktreeCache(folder)
    }
    assert.deepEqual(await listNativeWorktrees(context(nonGit)), {
      ...(missingGit ? { gitAvailable: false } : { isGitRepo: false }),
      worktrees: [{ slug: "root", directory: nonGit, serviceDirectory: nonGit, kind: "root",
        ...(missingGit ? { directoryOnly: true } : {}) }],
    })
    if (!ceiling) assert.equal(await sharesGitCommonDirectory(repo, linked, true), true)
    else await assert.rejects(sharesGitCommonDirectory(repo, linked, true), /Git discovery is configured/)
    const manager = new WorkspaceManager({ rootDir: repo,
      settings: { getOwner: () => ({ environmentVariables: {} }) },
      binaryResolver: { resolveDefault: () => ({ path: process.execPath, label: "fixture" }) },
      eventBus: new EventBus(), logger: pino({ level: "silent" }),
      sharedService: { headers: async () => ({}), client: async () => ({}), shutdown: async () => {},
        validateLocation: async location => ({ ...location, project: { id: "fixture", directory: repo, canonical: repo } }) },
    })
    try {
      const { workspace } = await manager.create(ceiling ? nested : repo)
      assert.equal(await manager.ownsLocation(workspace.id, { directory: workspace.path }, undefined, { strict: true }), true)
      for (const purpose of ["request", "event"]) for (const strict of [true, false, true]) {
        const ownership = manager.ownsLocation(workspace.id, { directory: linked }, undefined, { purpose, strict })
        if (!strict) assert.equal(await ownership, false)
        else await assert.rejects(ownership, ceiling ? /Git discovery is configured/ : expectedError)
      }
    } finally { await manager.shutdown() }
    console.log("PASS " + (missingGit ? "missing Git" : ceiling ? "GIT_CEILING_DIRECTORIES" : "unsafe-directory fallback"))
  `
  for (const mode of ["unsafe", "missing", "ceiling"]) {
    const privateEnv = { ...env }
    if (mode === "missing") {
      for (const key of Object.keys(privateEnv)) if (key.toLowerCase() === "path") delete privateEnv[key]
      privateEnv.PATH = emptyPath
    } else if (mode === "ceiling") privateEnv.GIT_CEILING_DIRECTORIES = repo
    else privateEnv.GIT_TEST_ASSUME_DIFFERENT_OWNER = "1"
    const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: privateEnv, windowsHide: true, encoding: "utf8", timeout: 20_000, stdio: "pipe",
    })
    assert.match(output, /PASS/)
    t.diagnostic(output.trim())
  }
})
