import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { closeSync, existsSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { createFamilyAuthorityIdentityFence, readFamilyAuthorityIdentity, readFamilyAuthorityIdentitySync } from "./family-authority-claim"

const git = (directory: string, ...args: string[]) => execFileSync("git", ["-C", directory, ...args], {
  encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
}).replace(/\r?\n$/, "")
const gitPath = (file: string) => file.replaceAll("\\", "/")
// Windows marks linked .git files hidden; opening r+ preserves that attribute.
const replaceBytes = (file: string, bytes: Buffer) => {
  const fd = openSync(file, "r+")
  try { ftruncateSync(fd, 0); writeFileSync(fd, bytes) } finally { closeSync(fd) }
}

/** A Git-fallback fence runs synchronous Git with a 3 s timeout and correctly
 * fails closed when a loaded host exceeds it; retry that transient refusal. */
function withSlowGit(fence: () => string): string {
  for (let attempt = 1; ; attempt++) {
    try { return fence() } catch (error) { if (attempt >= 5) throw error }
  }
}

test("physical family fences recheck real local Git inputs without processes", async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "opencode", "family-fence-"))
  const environment = { ...process.env }
  try {
    for (const key of Object.keys(process.env)) if (key.toUpperCase().startsWith("GIT_")) delete process.env[key]
    process.env.GIT_CONFIG_NOSYSTEM = "1"
    process.env.GIT_CONFIG_GLOBAL = path.join(temporary, "absent-global")
    const trace = path.join(temporary, "trace.json")
    process.env.GIT_TRACE2_EVENT = gitPath(trace)
    const repo = path.join(temporary, "main checkout"), linked = path.join(temporary, "linked checkout")
    git(temporary, "init", "-q", repo)
    git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "initial")
    git(repo, "worktree", "add", "--detach", linked)
    const common = git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir")
    const admin = git(linked, "rev-parse", "--absolute-git-dir")
    const family = await readFamilyAuthorityIdentity(repo)
    const config = path.join(common, "config")
    const originalConfig = readFileSync(config)

    await t.test("ordinary, linked and nested checkouts have no final Git processes; measured ceiling", async () => {
      const nested = path.join(linked, "nested", "folder")
      mkdirSync(nested, { recursive: true })
      for (const directory of [repo, linked, nested]) {
        const fence = await createFamilyAuthorityIdentityFence(directory)
        writeFileSync(trace, "")
        const start = performance.now()
        for (let i = 0; i < 10; i++) assert.equal(fence(), family)
        const fast = performance.now() - start
        assert.equal(readFileSync(trace, "utf8"), "", "every final fence must remain process-free")
        const legacyStart = performance.now()
        for (let i = 0; i < 10; i++) assert.equal(readFamilyAuthorityIdentitySync(directory), family)
        const legacy = performance.now() - legacyStart
        t.diagnostic(`${path.basename(directory)}: 10 filesystem fences ${fast.toFixed(1)}ms; 10 Git fences ${legacy.toFixed(1)}ms`)
        assert(fast < legacy / 2, "filesystem fence must cost less than half the repeated Git resolution")
      }
    })

    await t.test("nested .git/bare routing changes revoke identity; unrelated configuration does not", async () => {
      const nested = path.join(repo, "nested")
      mkdirSync(nested)
      const fence = await createFamilyAuthorityIdentityFence(nested)
      git(nested, "init", "-q")
      assert.throws(fence, /family-identity-unavailable/)
      rmSync(path.join(nested, ".git"), { recursive: true })
      assert.equal(fence(), family)
      git(nested, "init", "--bare", "-q")
      assert.throws(fence, /family-identity-unavailable/, "bare nested discovery has no .git entry")
      for (const entry of ["HEAD", "objects", "refs"]) rmSync(path.join(nested, entry), { recursive: true })
      writeFileSync(process.env.GIT_CONFIG_GLOBAL!, "[user]\n\tname = A new unrelated setting\n")
      assert.equal(fence(), family, "configuration creation alone is not reassignment")
      const redirected = path.join(temporary, "redirected main")
      mkdirSync(redirected)
      try {
        git(repo, "config", "core.worktree", redirected)
        assert.throws(fence, /family-identity-unavailable/)
      } finally {
        writeFileSync(config, originalConfig)
        rmSync(process.env.GIT_CONFIG_GLOBAL!, { force: true })
      }
    })

    await t.test("ordinary model edits, branches and commits never revoke; unchanged sentinels remain process-free", async () => {
      const fence = await createFamilyAuthorityIdentityFence(repo)
      writeFileSync(path.join(repo, "model-edited.txt"), "ordinary model edit\n")
      git(repo, "switch", "-c", "another-branch")
      writeFileSync(trace, "")
      assert.equal(fence(), family, "atomic HEAD replacement must revalidate routing without revoking")
      const starts = () => readFileSync(trace, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line))
        .filter(event => event.event === "start").length
      assert.equal(starts(), 1, "a changed HEAD needs one Git routing validation")
      writeFileSync(trace, "")
      assert.equal(fence(), family)
      assert.equal(readFileSync(trace, "utf8"), "", "the newly validated unchanged HEAD remains process-free")
      git(repo, "add", "model-edited.txt")
      git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "normal model commit")
      writeFileSync(trace, "")
      assert.equal(fence(), family)
      assert.equal(readFileSync(trace, "utf8"), "", "HEAD/branch/content are not routing fingerprints")
      try {
        git(repo, "config", "user.name", "Unrelated local edit")
        assert.equal(withSlowGit(fence), family, "unrelated local settings remain valid")
      } finally { writeFileSync(config, originalConfig) }
    })

    await t.test("missing, replaced and type-changed HEAD cannot retain an inner family's routing", async () => {
      const inner = path.join(repo, "inner checkout")
      git(repo, "init", "-q", inner)
      const innerFamily = await readFamilyAuthorityIdentity(inner)
      assert.notEqual(innerFamily, family)
      const fence = await createFamilyAuthorityIdentityFence(inner)
      const head = path.join(inner, ".git", "HEAD"), saved = head + ".saved"
      const original = readFileSync(head)
      assert.equal(fence(), innerFamily)
      renameSync(head, saved)
      try {
        assert.equal(readFamilyAuthorityIdentitySync(inner), family, "Git now discovers the outer repository")
        assert.throws(fence, /family-identity-unavailable/)
        mkdirSync(head)
        assert.throws(fence, /family-identity-unavailable/, "directory replacement is not a valid HEAD")
        rmSync(head, { recursive: true })
        writeFileSync(head, original)
        assert.equal(fence(), innerFamily, "a genuine HEAD inode replacement keeps unchanged routing valid")
        rmSync(head)
      } finally { if (existsSync(saved)) renameSync(saved, head) }
    })

    await t.test("in-place malformed HEAD discovers the outer family; legitimate symbolic-ref edits validate once", async () => {
      const inner = path.join(repo, "in-place inner checkout")
      git(repo, "init", "-q", inner)
      const innerFamily = await readFamilyAuthorityIdentity(inner)
      const fence = await createFamilyAuthorityIdentityFence(inner)
      const head = path.join(inner, ".git", "HEAD"), original = readFileSync(head)
      const identity = (stat: import("node:fs").BigIntStats) => [stat.dev, stat.ino, stat.birthtimeNs]
      const before = lstatSync(head, { bigint: true })
      try {
        // Same size and inode: timestamps must detect this invalid routing write.
        replaceBytes(head, Buffer.alloc(original.length, "x"))
        assert.deepEqual(identity(lstatSync(head, { bigint: true })), identity(before))
        assert.equal(readFamilyAuthorityIdentitySync(inner), family)
        assert.throws(fence, /family-identity-unavailable/)
        replaceBytes(head, Buffer.from("ref: refs/heads/legitimate-other-branch\n"))
        writeFileSync(trace, "")
        assert.equal(fence(), innerFamily, "valid in-place branch changes must not revoke authority")
        const starts = readFileSync(trace, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line))
          .filter(event => event.event === "start")
        assert.equal(starts.length, 1)
        writeFileSync(trace, "")
        assert.equal(fence(), innerFamily)
        assert.equal(readFileSync(trace, "utf8"), "", "no subprocess until HEAD metadata changes again")
      } finally { replaceBytes(head, original) }
    })

    await t.test("an incomplete nested .git becoming valid in place cannot borrow the outer family's fence", async () => {
      const inner = path.join(repo, "ambiguous inner checkout")
      git(repo, "init", "-q", inner)
      const innerFamily = await readFamilyAuthorityIdentity(inner)
      const entry = path.join(inner, ".git"), head = path.join(entry, "HEAD"), saved = head + ".saved"
      const identity = (stat: import("node:fs").BigIntStats) => [stat.dev, stat.ino, stat.birthtimeNs]
      const before = identity(lstatSync(entry, { bigint: true }))
      renameSync(head, saved)
      try {
        assert.equal(await readFamilyAuthorityIdentity(inner), family)
        const outerFence = await createFamilyAuthorityIdentityFence(inner)
        writeFileSync(trace, "")
        assert.equal(withSlowGit(outerFence), family)
        assert.notEqual(readFileSync(trace, "utf8"), "", "ambiguous nested discovery must retain fresh Git resolution")
        renameSync(saved, head)
        assert.deepEqual(identity(lstatSync(entry, { bigint: true })), before, "the nested .git directory was not replaced")
        assert.equal(await readFamilyAuthorityIdentity(inner), innerFamily)
        assert.throws(outerFence, /family-identity-unavailable/, "the acquired outer-family fence must refuse newly discoverable inner routing")
        const innerFence = await createFamilyAuthorityIdentityFence(inner)
        writeFileSync(trace, "")
        assert.equal(innerFence(), innerFamily)
        assert.equal(readFileSync(trace, "utf8"), "", "a now-complete verified inner root keeps the normal fast path")
        git(inner, "symbolic-ref", "HEAD", "refs/heads/another-valid-branch")
        assert.equal(innerFence(), innerFamily, "a valid verified-root HEAD change remains accepted")
        renameSync(head, saved)
        assert.equal(withSlowGit(outerFence), family, "returning to the acquired outer routing remains valid")
      } finally { if (existsSync(saved)) renameSync(saved, head) }
    })

    await t.test("Windows routing environment capture is case-insensitive and keeps exact values", {
      skip: process.platform !== "win32",
    }, async () => {
      const other = path.join(temporary, "environment family")
      git(temporary, "init", "-q", other)
      const otherFamily = await readFamilyAuthorityIdentity(other)
      const fence = await createFamilyAuthorityIdentityFence(repo)
      try {
        process.env.git_common_dir = otherFamily
        assert.equal(readFamilyAuthorityIdentitySync(repo), otherFamily, "native Git honors the lowercase Windows override")
        assert.throws(fence, /family-identity-unavailable/)
        const directed = await createFamilyAuthorityIdentityFence(repo)
        assert.equal(withSlowGit(directed), otherFamily)
        process.env.GiT_CoMmOn_DiR = family
        assert.throws(directed, /family-identity-unavailable/, "case aliases must retain exact-value change detection")
      } finally { delete process.env.git_common_dir }
      assert.equal(fence(), family)
    })

    await t.test(".git, commondir and backlinks are exact inputs, not a family-prefix guard", async () => {
      const other = path.join(temporary, "other checkout")
      git(repo, "worktree", "add", "--detach", other)
      const entry = path.join(linked, ".git"), pointer = readFileSync(entry)
      const commonFile = path.join(admin, "commondir"), commonBytes = readFileSync(commonFile)
      const backlink = path.join(admin, "gitdir"), backlinkBytes = readFileSync(backlink)
      const fence = await createFamilyAuthorityIdentityFence(linked)
      for (const [file, changed, original] of [
        [entry, readFileSync(path.join(other, ".git")), pointer],
        [commonFile, Buffer.from(gitPath(path.join(temporary, "unrelated"))), commonBytes],
        [backlink, Buffer.from(gitPath(path.join(other, ".git"))), backlinkBytes],
      ] as const) {
        replaceBytes(file, changed)
        assert.throws(fence, /family-identity-unavailable/)
        replaceBytes(file, original)
        assert.equal(fence(), family)
      }
      renameSync(entry, entry + ".saved")
      writeFileSync(entry, pointer)
      assert.throws(fence, /family-identity-unavailable/, "identical bytes cannot substitute a new .git inode")
      rmSync(entry); renameSync(entry + ".saved", entry)
    })

    await t.test("worktree extension and relative/absolute core.worktree remain resolved by Git", async () => {
      const worktreeConfig = path.join(admin, "config.worktree")
      try {
        git(repo, "config", "extensions.worktreeConfig", "true")
        git(linked, "config", "--worktree", "core.worktree", linked)
        const fence = await createFamilyAuthorityIdentityFence(linked)
        writeFileSync(trace, "")
        assert.equal(fence(), family)
        assert.equal(readFileSync(trace, "utf8"), "")
        const redirected = path.join(temporary, "effective root")
        mkdirSync(redirected)
        for (const value of [redirected, gitPath(path.relative(admin, redirected))]) {
          git(linked, "config", "--worktree", "core.worktree", value)
          assert.equal(realpathSync(git(linked, "rev-parse", "--show-toplevel")), realpathSync(redirected))
          assert.throws(fence, /family-identity-unavailable/)
          // Redirected roots lacking their own .git retain the current Git resolver.
          const redirectedFence = await createFamilyAuthorityIdentityFence(linked)
          assert.equal(withSlowGit(redirectedFence), withSlowGit(() => readFamilyAuthorityIdentitySync(linked)))
        }
      } finally {
        writeFileSync(config, originalConfig)
        rmSync(worktreeConfig, { force: true })
      }
    })

    await t.test("missing and conditional includes retain Git at every final fence", async () => {
      const missing = path.join(temporary, "missing-included-config")
      for (const key of ["include.path", `includeIf.gitdir:${gitPath(common)}/.path`]) {
        // Restore even on failure: a leftover include would cascade into later subtests.
        try {
          git(repo, "config", key, gitPath(missing))
          const fence = await createFamilyAuthorityIdentityFence(repo)
          writeFileSync(trace, "")
          assert.equal(withSlowGit(fence), family)
          assert.notEqual(readFileSync(trace, "utf8"), "", "cannot freeze incomplete config dependencies")
        } finally { writeFileSync(config, originalConfig) }
      }
    })

    await t.test("moved roots, alias retargeting and environment changes revoke the final fence", async () => {
      const alias = path.join(temporary, "alias"), moved = linked + ".moved"
      await symlink(linked, alias, process.platform === "win32" ? "junction" : "dir")
      const fence = await createFamilyAuthorityIdentityFence(alias)
      assert.equal(fence(), family)
      renameSync(linked, moved)
      assert.throws(fence, /family-identity-unavailable/)
      renameSync(moved, linked)
      await rm(alias)
      await symlink(repo, alias, process.platform === "win32" ? "junction" : "dir")
      assert.throws(fence, /family-identity-unavailable/)
      const plain = await createFamilyAuthorityIdentityFence(repo)
      process.env.GIT_COMMON_DIR = common
      assert.throws(plain, /family-identity-unavailable/)
      delete process.env.GIT_COMMON_DIR
    })
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]
    Object.assign(process.env, environment)
    await rm(temporary, { recursive: true, force: true })
  }
})
