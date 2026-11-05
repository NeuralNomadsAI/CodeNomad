import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { MemoryError } from "./model"
import { normalizeMemoryRemote, resolveMemoryProjectIdentity } from "./project-identity"

const git = (directory: string, ...args: string[]) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", windowsHide: true }).trim()
const resolve = (directory: string) => resolveMemoryProjectIdentity({ directory })

test("remote normalization shares transport-independent identities, strips credentials and retains explicit ports", () => {
  for (const url of ["git@EXAMPLE.com:team/app.git", "ssh://alice:secret@Example.COM/team/app.git/", "https://alice:secret@EXAMPLE.com/team/app.git?token=secret#fragment", "git://example.com/team/app"]) {
    assert.equal(normalizeMemoryRemote(url), "example.com/team/app")
  }
  for (const [url, normalized] of [
    ["ssh://git@Example.com:2222/team/app.git", "example.com:2222/team/app"],
    ["ssh://git@Example.com:02222/team/app.git", "example.com:2222/team/app"],
    ["https://example.com:443/team/app.git", "example.com:443/team/app"],
    ["https://example.com:8443/team/app.git", "example.com:8443/team/app"],
    ["ssh://git@[2001:db8::1]:2222/group/sub/repo.git", "[2001:db8::1]:2222/group/sub/repo"],
    ["git@host:repo.git", "host/repo"],
  ]) assert.equal(normalizeMemoryRemote(url!), normalized)
  for (const value of ["C:/repo", "file:///srv/repo.git", "https://host/../..", "ssh://host/team/%2e%2e", "git@host:../escape", "", "https://ho_st/team/app"]) {
    assert.equal(normalizeMemoryRemote(value), undefined, value)
  }
})

test("identity selects origin rather than upstream, otherwise the first sorted remote; local folders/worktrees stay shared", async () => {
  const parent = path.join(os.tmpdir(), "opencode")
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(path.join(parent, "memory-project-"))
  try {
    const repo = path.join(root, "repo"), linked = path.join(root, "linked"), plain = path.join(root, "plain")
    await mkdir(repo); await mkdir(plain)
    git(repo, "init", "-q")
    git(repo, "-c", "user.name=Memory fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "fixture")
    git(repo, "worktree", "add", "--detach", "-q", linked)
    await mkdir(path.join(linked, "packages"))
    const initial = await resolve(repo)
    assert.equal(initial.source, "local")
    assert.match(initial.id, /^[a-f0-9]{64}$/)
    assert.deepEqual(await resolve(path.join(linked, "packages")), initial)
    assert.notDeepEqual(await resolve(plain), initial)
    assert.deepEqual(await resolve(plain), await resolve(await realpath(plain)))
    const alias = path.join(root, "alias")
    await symlink(plain, alias, process.platform === "win32" ? "junction" : "dir")
    assert.deepEqual(await resolve(alias), await resolve(plain))

    git(repo, "remote", "add", "upstream", "https://example.com/foreign/repo.git")
    git(repo, "remote", "add", "z-backup", "https://example.com/z/repo.git")
    git(repo, "remote", "add", "a-backup", "git@EXAMPLE.com:team/app.git")
    const sorted = await resolve(repo)
    assert.equal(sorted.source, "remote")
    git(repo, "remote", "add", "origin", "https://alice:secret@example.COM/team/app")
    assert.deepEqual(await resolve(repo), sorted)
    assert.deepEqual(await resolve(path.join(linked, "packages")), sorted)
    git(repo, "remote", "set-url", "origin", "ssh://git@example.com:2222/team/app.git")
    assert.notDeepEqual(await resolve(repo), sorted, "SSH transport port is part of memory identity")
    git(repo, "remote", "set-url", "origin", "../local-remote.git")
    assert.deepEqual(await resolve(repo), initial, "an unusable chosen origin falls back locally, never to upstream")
    await writeFile(path.join(plain, ".git"), "gitdir: /missing-memory-fixture\n")
    await assert.rejects(resolve(plain), (error: unknown) => error instanceof MemoryError && error.code === "unreadable")
    await assert.rejects(resolve(path.join(root, "absent")), (error: unknown) => error instanceof MemoryError && error.code === "unreadable")
  } finally { await rm(root, { recursive: true, force: true }) }
})

const distro = process.env.CODENOMAD_MEMORY_TEST_WSL_DISTRO
test("real WSL Git keeps worktrees/subfolders and UNC spellings on one memory identity", { skip: process.platform !== "win32" || !distro }, async () => {
  const wsl = (executable: string, ...args: string[]) => execFileSync("wsl.exe", ["--distribution", distro!, "--exec", executable, ...args], {
    encoding: "utf8", windowsHide: true, timeout: 30_000,
  }).trim()
  const root = wsl("mktemp", "-d", "/tmp/codenomad-memory-project-XXXXXX")
  const repo = `${root}/repo`, linked = `${root}/linked`
  const read = (directory: string) => resolveMemoryProjectIdentity({ directory, distro })
  try {
    wsl("git", "init", "-q", repo)
    wsl("git", "-C", repo, "-c", "user.name=Memory fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "fixture")
    wsl("git", "-C", repo, "worktree", "add", "--detach", "-q", linked)
    wsl("mkdir", "-p", `${linked}/packages`)
    assert.deepEqual(await read(repo), await read(`${linked}/packages`))
    const unc = `\\\\wsl.localhost\\${distro}${repo.replace(/\//g, "\\")}`
    assert.deepEqual(await resolveMemoryProjectIdentity({ directory: unc }), await read(repo))
    wsl("git", "-C", repo, "remote", "add", "origin", "ssh://git@EXAMPLE.com:2222/team/app.git")
    const remote = await read(repo)
    assert.equal(remote.source, "remote")
    assert.deepEqual(remote, await read(`${linked}/packages`))
    wsl("mkdir", "-p", `${root}/plain`)
    assert.equal((await read(`${root}/plain`)).source, "local")
  } finally { wsl("rm", "-rf", "--", root) }
})

test("WSL identities use Linux Git and realpath, unify UNC aliases, preserve path case and scope fallback by distro", async () => {
  const calls: { distro: string; executable: string; args: string[] }[] = []
  let remote = "ssh://git@EXAMPLE.com:2222/team/app.git"
  let noRepository = false
  const run = async (distro: string, executable: "git" | "realpath", args: string[]) => {
    calls.push({ distro, executable, args })
    if (executable === "realpath") return args[1]!.replace("/alias", "/repo")
    if (args.includes("rev-parse")) {
      if (noRepository) throw { code: 128, stderr: "fatal: not a git repository (or any of the parent directories): .git" }
      return "/home/Me/repo/.git"
    }
    if (args.includes("get-url")) return remote
    return remote ? "origin" : ""
  }
  const a = await resolveMemoryProjectIdentity({ directory: "\\\\wsl.localhost\\Ubuntu\\home\\Me\\repo\\pkg" }, run)
  const b = await resolveMemoryProjectIdentity({ directory: "\\\\wsl$\\ubuntu\\home\\Me\\linked" }, run)
  assert.deepEqual(a, b)
  assert.deepEqual(await resolveMemoryProjectIdentity({ directory: "/home/Me/linked", distro: "ubuntu" }, run), a)
  assert(calls.every(call => call.executable !== "git" || call.args[0] === "-C"))
  assert(calls.some(call => call.args[1] === "/home/Me/repo/pkg"))
  remote = ""
  const local = await resolveMemoryProjectIdentity({ directory: "/home/Me/linked", distro: "ubuntu" }, run)
  assert.equal(local.source, "local")
  assert.deepEqual(await resolveMemoryProjectIdentity({ directory: "/home/Me/repo/pkg", distro: "Ubuntu" }, run), local)
  assert.notDeepEqual(await resolveMemoryProjectIdentity({ directory: "/home/Me/repo", distro: "Debian" }, run), local)
  noRepository = true
  assert.notDeepEqual(await resolveMemoryProjectIdentity({ directory: "/home/me/repo", distro: "ubuntu" }, run), local)
  await assert.rejects(resolveMemoryProjectIdentity({ directory: "\\\\wsl$\\Ubuntu\\repo", distro: "Debian" }, run), MemoryError)
  await assert.rejects(resolveMemoryProjectIdentity({ directory: "relative", distro: "Ubuntu" }, run), MemoryError)
  await assert.rejects(resolveMemoryProjectIdentity({ directory: "/repo", distro: "Ubuntu" }, async () => { throw { code: "ENOENT" } }),
    (error: unknown) => error instanceof MemoryError && error.code === "git_unavailable")
})
