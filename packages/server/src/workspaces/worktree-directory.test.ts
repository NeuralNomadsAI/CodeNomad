import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { realpath } from "node:fs/promises"
import fs from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { invalidateWorktreeCache, isPathWithinWorktree, resolveOwnedWorktreePath } from "./worktree-directory"
import { fixtureCatalogue } from "./__tests__/native-worktree-fixture"
import { WORKTREE_OWNERSHIP_RESTART_LIMIT, WorktreeInventory } from "./worktree-inventory"

test("concurrent ownership misses share a refresh and cache negative results until invalidation", async (t) => {
  const temp = mkdtempSync(path.join(tmpdir(), "codenomad-inventory-misses-"))
  t.after(() => { invalidateWorktreeCache(temp); rmSync(temp, { recursive: true, force: true }) })
  const root = path.join(temp, "repo")
  const foreign = path.join(temp, "foreign")
  mkdirSync(root)
  mkdirSync(foreign)
  let loads = 0
  const loadWorktrees = async () => {
    loads++
    await new Promise(resolve => setTimeout(resolve, 30))
    return [{ slug: "root", directory: root, kind: "root" as const }]
  }
  const params = { workspaceId: temp, workspacePath: root, loadWorktrees }
  await resolveOwnedWorktreePath({ ...params, directory: root })
  const results = await Promise.all(Array.from({ length: 40 }, () => resolveOwnedWorktreePath({ ...params, directory: foreign })))
  assert.ok(results.every(result => result === null))
  assert.equal(loads, 2)
  await resolveOwnedWorktreePath({ ...params, directory: foreign })
  assert.equal(loads, 2)
  invalidateWorktreeCache(temp)
  await resolveOwnedWorktreePath({ ...params, directory: foreign })
  assert.ok(loads > 2)
})

test("resolves nested and junction paths to their canonical owning worktree", async (t) => {
  const temp = mkdtempSync(path.join(tmpdir(), "codenomad-worktree-path-"))
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  const root = path.join(temp, "repo")
  const worktree = path.join(root, ".codenomad", "worktrees", "doomed")
  const alias = path.join(temp, "alias")
  mkdirSync(root)
  execFileSync("git", ["init", "--initial-branch=main", root])
  writeFileSync(path.join(root, "README.md"), "test\n")
  execFileSync("git", ["-C", root, "add", "README.md"])
  execFileSync("git", ["-C", root, "-c", "user.name=CodeNomad Test", "-c", "user.email=test@codenomad.local", "commit", "-m", "test"])
  const workspaceId = `workspace-${Date.now()}`
  const loadWorktrees = async () => (await fixtureCatalogue(root)).worktrees
  assert.equal((await resolveOwnedWorktreePath({ workspaceId, workspacePath: root, directory: root, loadWorktrees }))?.slug, "root")
  mkdirSync(path.dirname(worktree), { recursive: true })
  execFileSync("git", ["-C", root, "worktree", "add", "-b", "doomed", worktree])
  mkdirSync(path.join(worktree, "nested"))
  symlinkSync(worktree, alias, "junction")
  const external = path.join(temp, "external")
  const dangling = path.join(worktree, "dangling")
  mkdirSync(external)
  symlinkSync(external, dangling, "junction")
  rmSync(external, { recursive: true })

  const resolved = await resolveOwnedWorktreePath({
    loadWorktrees,
    workspaceId,
    workspacePath: root,
    directory: path.join(alias, "nested"),
  })

  const expectedSlug = (await loadWorktrees()).find(entry => entry.branch === "doomed")!.slug
  assert.equal(resolved?.slug, expectedSlug)
  assert.equal(resolved?.directory, await realpath(path.join(worktree, "nested")))
  assert.equal(resolved?.worktreeDirectory, await realpath(worktree))
  assert.equal((await resolveOwnedWorktreePath({
    loadWorktrees,
    workspaceId,
    workspacePath: root,
    directory: path.join(worktree, "missing", "nested"),
  }))?.slug, expectedSlug)
  assert.equal(await resolveOwnedWorktreePath({ workspaceId, workspacePath: root, directory: path.join(dangling, "nested"), loadWorktrees }), null)
  assert.equal(isPathWithinWorktree("\\\\wsl.localhost\\Ubuntu\\repo\\Foo", "\\\\wsl.localhost\\Ubuntu\\repo\\foo\\nested"), false)
  assert.equal(isPathWithinWorktree("\\\\wsl.localhost\\Ubuntu\\repo\\Foo", "\\\\wsl.localhost\\Ubuntu\\repo\\Foo\\nested"), true)
  assert.equal(isPathWithinWorktree("\\\\WSL.LOCALHOST\\ubuntu\\repo\\Foo", "\\\\wsl.localhost\\Ubuntu\\repo\\Foo\\nested"), true)
})

test("distinct foreign event directories share one ownership refresh until invalidation", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() })
  const temp = mkdtempSync(path.join(tmpdir(), "codenomad-foreign-events-"))
  t.after(() => { invalidateWorktreeCache(temp); rmSync(temp, { recursive: true, force: true }) })
  const root = path.join(temp, "repo")
  mkdirSync(root)
  let loads = 0
  const inventory = [{ slug: "root", directory: root, kind: "root" as const }]
  const params = {
    workspaceId: temp, workspacePath: root,
    loadWorktrees: async () => { loads++; return inventory },
  }
  await resolveOwnedWorktreePath({ ...params, directory: root })
  // The global native stream contains unrelated projects and temporary checkouts.
  // Its serial router must not reload every repository's inventory for each one.
  const foreign = Array.from({ length: 20 }, (_, i) => path.join(temp, `foreign-${i}`))
  for (const directory of foreign) {
    mkdirSync(directory)
    assert.equal(await resolveOwnedWorktreePath({ ...params, directory }), null)
  }
  assert.equal(loads, 2, "at most one miss refresh for the current inventory")
  assert.equal(await resolveOwnedWorktreePath({ ...params, directory: foreign[0] }), null)
  assert.equal(loads, 2)
  // A native worktree event invalidates the snapshot, including negative matches.
  inventory.push({ slug: "linked", directory: foreign[0], kind: "root" })
  invalidateWorktreeCache(temp)
  assert.equal((await resolveOwnedWorktreePath({ ...params, directory: foreign[0] }))?.slug, "linked")
  assert.equal(loads, 3)
  // An external change without an event is still discovered after the cache TTL.
  inventory.push({ slug: "external", directory: foreign[1], kind: "root" })
  t.mock.timers.tick(10_001)
  assert.equal((await resolveOwnedWorktreePath({ ...params, directory: foreign[1] }))?.slug, "external")
  assert.equal(loads, 4)
})

test("an ownership miss bypasses the warm lower inventory cache once", async t => {
  const temp = mkdtempSync(path.join(tmpdir(), "codenomad-layered-cache-"))
  t.after(() => { invalidateWorktreeCache(temp); rmSync(temp, { recursive: true, force: true }) })
  const root = path.join(temp, "repo")
  const nested = path.join(root, "linked")
  mkdirSync(nested, { recursive: true })
  const worktrees = [{ slug: "root", directory: root, kind: "root" as const }]
  let scans = 0
  const inventory = new WorktreeInventory({
    load: async () => { scans++; return { isGitRepo: true, worktrees: [...worktrees] } },
    changed: () => invalidateWorktreeCache(temp),
    failed: () => {},
  })
  const params = {
    workspaceId: temp, workspacePath: root,
    loadWorktrees: async (refresh?: boolean) => (await inventory.read(temp, refresh ? "fresh" : "validated")).worktrees,
  }
  assert.equal((await resolveOwnedWorktreePath({ ...params, directory: root }))?.slug, "root")
  worktrees.push({ slug: "linked", directory: nested, kind: "root" })
  // No native update event yet. Resolving the nested checkout must not collapse
  // it to the parent repository's mutation/deletion identity.
  assert.equal((await resolveOwnedWorktreePath({ ...params, directory: nested }))?.slug, "linked")
  assert.equal(scans, 2)
  for (let i = 0; i < 20; i++) {
    assert.equal(await resolveOwnedWorktreePath({ ...params, directory: path.join(temp, `foreign-${i}`) }), null)
  }
  assert.equal(scans, 2)
})

test("an invalidated directory load cannot return obsolete ownership to its awaiting caller", async t => {
  const temp = mkdtempSync(path.join(tmpdir(), "codenomad-directory-generation-"))
  t.after(() => { invalidateWorktreeCache(temp); rmSync(temp, { recursive: true, force: true }) })
  const root = path.join(temp, "repo")
  mkdirSync(root)
  let release!: () => void
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const blocked = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const read = resolveOwnedWorktreePath({
    workspaceId: temp, workspacePath: root, directory: root,
    loadWorktrees: async () => {
      if (++calls !== 1) return []
      started()
      await blocked
      return [{ slug: "root", directory: root, kind: "root" }]
    },
  })
  await ready
  invalidateWorktreeCache(temp)
  release()
  assert.equal(await read, null)
})

test("strict ownership revalidates cached fallback paths and propagates realpath failures", async t => {
  const temp = mkdtempSync(path.join(tmpdir(), "codenomad-strict-directory-"))
  t.after(() => { invalidateWorktreeCache(temp); rmSync(temp, { recursive: true, force: true }) })
  const root = path.join(temp, "root")
  const missing = path.join(temp, "missing")
  mkdirSync(root)
  const params = {
    workspaceId: temp, workspacePath: root, directory: root,
    loadWorktrees: async () => [{ slug: "root", directory: missing, kind: "root" as const }],
  }
  assert.equal(await resolveOwnedWorktreePath(params), null)
  await assert.rejects(resolveOwnedWorktreePath({ ...params, strict: true }), { code: "ENOENT" })
  await assert.rejects(resolveOwnedWorktreePath({ ...params, directory: missing, strict: true }), { code: "ENOENT" })
})

test("strict ownership skips a missing projected project folder only after validating its registered root", async t => {
  const temp = mkdtempSync(path.join(tmpdir(), "codenomad-strict-projection-"))
  t.after(() => { invalidateWorktreeCache(temp); rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  const root = path.join(temp, "repo"), linked = path.join(temp, "linked")
  const project = path.join(root, "packages", "app")
  const projected = path.join(linked, "packages", "app")
  execFileSync("git", ["init", "--initial-branch=main", root], { windowsHide: true, stdio: "pipe" })
  execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "fixture"], { windowsHide: true, stdio: "pipe" })
  execFileSync("git", ["-C", root, "worktree", "add", "--detach", linked], { windowsHide: true, stdio: "pipe" })
  mkdirSync(project, { recursive: true })
  let reads = 0
  const worktrees = (await fixtureCatalogue(project, [root, linked])).worktrees
  assert.ok(worktrees.some(entry => entry.directory === projected), "native inventory includes the absent projection")
  const params = { workspaceId: temp, workspacePath: project, directory: project,
    loadWorktrees: async () => { reads++; return worktrees } }
  assert.equal((await resolveOwnedWorktreePath({ ...params, strict: true }))?.slug, "root")
  assert.equal((await resolveOwnedWorktreePath({ ...params, strict: true }))?.slug, "root", "warm strict read skips the missing projection")
  assert.equal(reads, 1)
  writeFileSync(path.join(linked, "packages"), "a file on this branch\n")
  assert.equal((await resolveOwnedWorktreePath({ ...params, strict: true }))?.slug, "root", "an intermediate file also proves the sibling projection unavailable")
  invalidateWorktreeCache(temp)
  assert.equal((await resolveOwnedWorktreePath({ ...params, strict: true }))?.slug, "root", "fresh strict reads skip non-directory sibling projections")
  rmSync(linked, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  await assert.rejects(resolveOwnedWorktreePath({ ...params, strict: true }), { code: "ENOENT" }, "the missing registered root remains a hard error")
})

test("strict ownership rejects a missing root project folder even when its registered checkout exists", async t => {
  const temp = mkdtempSync(path.join(tmpdir(), "codenomad-strict-root-projection-"))
  t.after(() => { invalidateWorktreeCache(temp); rmSync(temp, { recursive: true, force: true }) })
  const project = path.join(temp, "project"), target = path.join(temp, "target")
  mkdirSync(project)
  mkdirSync(target)
  let reads = 0
  const params = {
    workspaceId: temp, workspacePath: project, directory: project,
    loadWorktrees: async () => {
      reads++
      return [
        { slug: "root", directory: project, registeredDirectory: temp, kind: "root" as const },
        { slug: "linked", directory: target, registeredDirectory: target, kind: "worktree" as const },
      ]
    },
  }
  assert.equal((await resolveOwnedWorktreePath({ ...params, strict: true }))?.slug, "root")
  rmSync(project, { recursive: true })
  await assert.rejects(resolveOwnedWorktreePath({ ...params, directory: target, strict: true }), { code: "ENOENT" },
    "a missing opened-folder projection must reject even when the target and registered checkout still exist")
  assert.equal(reads, 1, "strict validation checks the cached root projection")
})

test("repeated directory-cache invalidations have two retries and one final fresh read", async t => {
  const temp = mkdtempSync(path.join(tmpdir(), "codenomad-directory-retry-bound-"))
  t.after(() => { invalidateWorktreeCache(temp); rmSync(temp, { recursive: true, force: true }) })
  const refreshes: boolean[] = []
  await assert.rejects(resolveOwnedWorktreePath({
    workspaceId: temp, workspacePath: temp, directory: temp, strict: true,
    loadWorktrees: async (refresh = false) => {
      refreshes.push(refresh)
      await Promise.resolve()
      invalidateWorktreeCache(temp)
      return [{ slug: "root", directory: temp, kind: "root" }]
    },
  }), /inventory changed repeatedly/)
  assert.deepEqual(refreshes, [false, false, false, true])
  refreshes.length = 0
  const absent = await resolveOwnedWorktreePath({
    workspaceId: temp, workspacePath: temp, directory: temp, strict: true,
    loadWorktrees: async (refresh = false) => {
      refreshes.push(refresh)
      await Promise.resolve()
      if (refreshes.length < 4) invalidateWorktreeCache(temp)
      return []
    },
  })
  assert.equal(absent, null)
  assert.deepEqual(refreshes, [false, false, false, true], "the final fresh miss needs no fifth read")
  invalidateWorktreeCache(temp)
  assert.equal((await resolveOwnedWorktreePath({
    workspaceId: temp, workspacePath: temp, directory: temp,
    loadWorktrees: async () => [{ slug: "root", directory: temp, kind: "root" }],
  }))?.slug, "root", "a later stable demand can recover")
})

test("the strict final fresh read bypasses a warm ordinary negative cache", async t => {
  const temp = mkdtempSync(path.join(tmpdir(), "codenomad-final-fresh-"))
  t.after(() => { invalidateWorktreeCache(temp); rmSync(temp, { recursive: true, force: true }) })
  const root = path.join(temp, "root"), linked = path.join(temp, "linked")
  mkdirSync(root); mkdirSync(linked)
  let added = false
  const refreshes: boolean[] = []
  const params = { workspaceId: temp, workspacePath: root, directory: linked,
    loadWorktrees: async (refresh = false) => {
      refreshes.push(refresh)
      return [{ slug: "root", directory: root, kind: "root" as const },
        ...(added ? [{ slug: "linked", directory: linked, kind: "worktree" as const }] : [])]
    } }
  assert.equal(await resolveOwnedWorktreePath(params), null)
  added = true
  assert.equal((await resolveOwnedWorktreePath({ ...params, strict: true }, { restarts: WORKTREE_OWNERSHIP_RESTART_LIMIT }))?.slug, "linked")
  assert.equal((await resolveOwnedWorktreePath(params))?.slug, "linked", "ordinary callers cannot inherit a stale final-read negative")
  assert.deepEqual(refreshes, [false, true, true])
})

test("the final strict fresh read never joins an in-flight validated scan", async t => {
  const temp = mkdtempSync(path.join(tmpdir(), "codenomad-final-scan-"))
  const root = path.join(temp, "root"), linked = path.join(temp, "linked")
  mkdirSync(root); mkdirSync(linked)
  let release!: () => void, started!: () => void, reached!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const scanning = new Promise<void>(resolve => { started = resolve })
  const finalTarget = new Promise<void>(resolve => { reached = resolve })
  const reads: Promise<unknown>[] = [], refreshes: boolean[] = []
  const actualRealpath = fs.realpath
  t.mock.method(fs, "realpath", async (directory: string) => {
    const result = await actualRealpath(directory)
    if (directory === linked) reached()
    return result
  })
  syncBuiltinESMExports()
  t.after(async () => {
    release(); await Promise.allSettled(reads)
    t.mock.restoreAll(); syncBuiltinESMExports()
    invalidateWorktreeCache(temp); rmSync(temp, { recursive: true, force: true })
  })
  const params = { workspaceId: temp, workspacePath: root, strict: true,
    loadWorktrees: async (refresh = false) => {
      refreshes.push(refresh)
      if (!refresh) { started(); await held }
      return [{ slug: "root", directory: root, kind: "root" as const },
        ...(refresh ? [{ slug: "linked", directory: linked, kind: "worktree" as const }] : [])]
    } }
  const other = resolveOwnedWorktreePath({ ...params, directory: root }); reads.push(other)
  await scanning
  const finalRead = resolveOwnedWorktreePath({ ...params, directory: linked }, { restarts: WORKTREE_OWNERSHIP_RESTART_LIMIT }); reads.push(finalRead)
  await finalTarget
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(refreshes, [false, true], "the final demand starts a fresh scan while the validated scan remains held")
  assert.equal((await finalRead)?.slug, "linked")
  release()
  assert.equal((await other)?.slug, "root")
  assert.equal((await resolveOwnedWorktreePath({ ...params, strict: false, directory: linked }))?.slug, "linked")
})

test("ordinary ownership preserves trailing reloads beyond four invalidations", async t => {
  const temp = mkdtempSync(path.join(tmpdir(), "codenomad-ordinary-reloads-"))
  t.after(() => { invalidateWorktreeCache(temp); rmSync(temp, { recursive: true, force: true }) })
  let reads = 0
  const result = await resolveOwnedWorktreePath({ workspaceId: temp, workspacePath: temp, directory: temp,
    loadWorktrees: async () => {
      await Promise.resolve()
      if (++reads <= 4) invalidateWorktreeCache(temp)
      return [{ slug: "root", directory: temp, kind: "root" }]
    } })
  assert.equal(result?.slug, "root")
  assert.equal(reads, 5)
})

test("ordinary synchronous loader invalidation preserves the baseline successive-call load counts", async t => {
  const temp = mkdtempSync(path.join(tmpdir(), "codenomad-ordinary-sync-invalidation-"))
  t.after(() => { invalidateWorktreeCache(temp); rmSync(temp, { recursive: true, force: true }) })
  const refreshes: boolean[] = []
  const params = { workspaceId: temp, workspacePath: temp, directory: temp,
    loadWorktrees: async (refresh = false) => {
      refreshes.push(refresh)
      if (refreshes.length <= 6) invalidateWorktreeCache(temp)
      return [{ slug: "root", directory: temp, kind: "root" as const }]
    } }
  const loads: number[] = []
  for (let i = 0; i < 3; i++) {
    assert.equal((await resolveOwnedWorktreePath(params))?.slug, "root")
    loads.push(refreshes.length)
  }
  assert.deepEqual(loads, [1, 1, 1])
  assert.deepEqual(refreshes, [false])
})

test("strict synchronous loader invalidation remains fenced and bounded", async t => {
  const temp = mkdtempSync(path.join(tmpdir(), "codenomad-strict-sync-invalidation-"))
  t.after(() => { invalidateWorktreeCache(temp); rmSync(temp, { recursive: true, force: true }) })
  const refreshes: boolean[] = []
  await assert.rejects(resolveOwnedWorktreePath({ workspaceId: temp, workspacePath: temp, directory: temp, strict: true,
    loadWorktrees: async (refresh = false) => {
      refreshes.push(refresh)
      invalidateWorktreeCache(temp)
      return [{ slug: "root", directory: temp, kind: "root" }]
    } }), /inventory changed repeatedly/)
  assert.deepEqual(refreshes, [false, false, false, true])
})

test("strict ownership stays bounded while an ordinary demand keeps trailing native scans", async t => {
  const temp = mkdtempSync(path.join(tmpdir(), "codenomad-mixed-ownership-"))
  const snapshot = { worktrees: [{ slug: "root", directory: temp, kind: "root" as const }] }
  const scans: Array<(value: typeof snapshot) => void> = []
  let started = () => {}, draining = false, readers = 0
  const inventory = new WorktreeInventory({ load: async () => {
    if (draining) return snapshot
    return new Promise<typeof snapshot>(resolve => { scans.push(resolve); started() })
  }, changed() {}, failed() {} })
  const params = (strict: boolean) => ({ workspaceId: temp, workspacePath: temp, directory: temp, strict,
    loadWorktrees: async () => { readers++; started(); return (await inventory.read(temp, "validated", { strict })).worktrees } })
  const ordinary = resolveOwnedWorktreePath(params(false))
  const strict = resolveOwnedWorktreePath(params(true))
  const rejected = assert.rejects(strict, /inventory changed repeatedly/)
  t.after(async () => {
    draining = true
    for (const resolve of scans) resolve(snapshot)
    await Promise.allSettled([ordinary, strict])
    invalidateWorktreeCache(temp)
    rmSync(temp, { recursive: true, force: true })
  })
  while (readers < 2) await new Promise<void>(resolve => { started = resolve })
  for (let i = 0; i < 4; i++) {
    while (scans.length < i + 1) await new Promise<void>(resolve => { started = resolve })
    assert.equal(scans.length, i + 1, "both readers share one native scan")
    inventory.invalidate(temp)
    invalidateWorktreeCache(temp)
    scans[i](snapshot)
  }
  await rejected
  while (scans.length < 5) await new Promise<void>(resolve => { started = resolve })
  assert.equal(scans.length, 5)
  scans[4](snapshot)
  assert.equal((await ordinary)?.slug, "root")
})

test("concurrent pending-scan handoffs retain each ownership demand's retry budget", async t => {
  const temp = mkdtempSync(path.join(tmpdir(), "codenomad-directory-handoffs-"))
  const snapshot = [{ slug: "root", directory: temp, registeredDirectory: temp, kind: "worktree" as const }]
  const scans: Array<{ generation: number; release(value: typeof snapshot): void }> = []
  const reads: Promise<void>[] = []
  const outcomes: Array<{ status: "fulfilled" | "rejected"; generation: number; result: unknown }> = []
  let active = 0, generation = 0, draining = false
  t.mock.method(fs, "realpath", async (directory: string) => directory)
  syncBuiltinESMExports()
  t.after(async () => {
    draining = true
    for (const scan of scans) scan.release(snapshot)
    await Promise.allSettled(reads)
    t.mock.restoreAll(); syncBuiltinESMExports()
    invalidateWorktreeCache(temp)
    rmSync(temp, { recursive: true, force: true })
  })
  const params = {
    workspaceId: temp, workspacePath: temp, directory: temp, strict: true,
    loadWorktrees: async () => {
      active++
      try {
        return draining ? snapshot : await new Promise<typeof snapshot>(release => { scans.push({ generation, release }) })
      } finally { active-- }
    },
  }
  for (let i = 0; i < 8; i++) {
    generation = i
    invalidateWorktreeCache(temp)
    reads.push(resolveOwnedWorktreePath(params).then(
      result => { outcomes[i] = { status: "fulfilled", generation, result } },
      result => { outcomes[i] = { status: "rejected", generation, result } },
    ))
    await new Promise<void>(resolve => setImmediate(resolve))
    for (const scan of scans.filter(scan => scan.generation < generation)) scan.release([])
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  draining = true
  for (const scan of scans) scan.release(snapshot)
  await Promise.all(reads)
  assert.equal(outcomes[0]?.status, "rejected", "the original demand cannot adopt eight callers' independent budgets")
  assert.ok(outcomes[0].generation <= 4, "the original demand settles within four invalidated generations")
  assert.match(String(outcomes[0].result), /inventory changed repeatedly/)
  assert.equal(active, 0, "every admitted loader has settled before cleanup")
  assert.equal(outcomes.at(-1)?.status, "fulfilled", "a later stable demand can recover")
})
