import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { checkDesignFolderExclusion, DESIGN_EXCLUDE_ENTRY, excludeDesignFolder, type ExcludeGit, type ExcludeTarget } from "./design-git-exclude"
import { ensureCodenomadGitExclude } from "./worktree-map"

let root: string
const git = (directory: string, ...args: string[]) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", windowsHide: true }).trim()
const host = (directory: string): ExcludeTarget => ({ directory, toHost: async value => value })
const excludeFile = (directory: string) => path.resolve(directory, git(directory, "rev-parse", "--git-path", "info/exclude"))
const count = (text: string) => text.split(/\r?\n/).filter(line => line.trim() === DESIGN_EXCLUDE_ENTRY).length

async function repository(name: string) {
  const directory = path.join(root, name)
  await mkdir(directory)
  git(directory, "init", "-b", "main")
  git(directory, "config", "user.name", "Exclude Fixture")
  git(directory, "config", "user.email", "fixture@example.invalid")
  git(directory, "config", "core.autocrlf", "false")
  await writeFile(path.join(directory, "README.md"), "fixture\n")
  git(directory, "add", ".")
  git(directory, "commit", "-m", "Initial")
  return directory
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "design-exclude-"))
  // Discovery never climbs above the fixture root into an unrelated repository.
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(root)
})
after(async () => {
  delete process.env.GIT_CEILING_DIRECTORIES
  await rm(root, { recursive: true, force: true })
})

test("appends the design folder once, keeps foreign bytes and leaves .gitignore alone", async () => {
  const directory = await repository("plain")
  const file = excludeFile(directory)
  // CRLF, a non-UTF-8 byte and no final newline must survive byte for byte.
  const foreign = Buffer.concat([Buffer.from("# local\r\n*.log\r\nbin/"), Buffer.from([0xff]), Buffer.from("cache")])
  await writeFile(file, foreign)

  assert.equal(await excludeDesignFolder(host(directory)), "excluded")
  const written = await readFile(file)
  assert.deepEqual(written.subarray(0, foreign.length), foreign)
  assert.equal(count(written.toString("utf8")), 1)
  assert.match(written.subarray(foreign.length).toString("utf8"), /^\n\n# codenomad\n\.codenomad\/design\/\n$/)

  assert.equal(await excludeDesignFolder(host(directory)), "excluded")
  assert.deepEqual(await readFile(file), written, "a second call adds nothing")
  assert.equal(existsSync(path.join(directory, ".gitignore")), false)

  await mkdir(path.join(directory, ".codenomad", "design", "subject"), { recursive: true })
  await writeFile(path.join(directory, ".codenomad", "design", "subject", "app-icon-minimal-a.png"), Buffer.from([0x89, 0x50]))
  assert.equal(git(directory, "status", "--porcelain"), "")
})

test("the read-only check reports missing or excluded as Git reads lines and leaves the file byte-identical", async () => {
  const directory = await repository("check")
  const file = excludeFile(directory)
  const nested = path.join(directory, "packages", "app")
  await mkdir(nested, { recursive: true })
  const bytes = async () => existsSync(file) ? await readFile(file) : undefined
  for (const content of [undefined, Buffer.from("# local\r\n*.log"), Buffer.from(".codenomad/design/x\n"), Buffer.from("/other/.codenomad/design/\n")]) {
    if (content) await writeFile(file, content); else await rm(file, { force: true })
    const before = await bytes()
    assert.equal(await checkDesignFolderExclusion(host(directory)), "missing", String(content))
    assert.equal(await checkDesignFolderExclusion(host(nested)), "missing")
    assert.deepEqual(await bytes(), before, "never written, never created")
  }
  // Git ignores a final \r and unescaped trailing spaces; leading whitespace is part of the pattern.
  for (const [content, expected] of [[".codenomad/design/\r\n", "excluded"], [".codenomad/design/   \n", "excluded"],
    [" .codenomad/design/\n", "missing"], [".codenomad/design/\\ \n", "missing"]] as const) {
    await writeFile(file, content)
    assert.equal(await checkDesignFolderExclusion(host(directory)), expected, JSON.stringify(content))
    assert.equal(await readFile(file, "utf8"), content)
  }
  await writeFile(file, "# keep\n")
  assert.equal(await excludeDesignFolder(host(nested)), "excluded")
  const written = await readFile(file)
  assert.equal(await checkDesignFolderExclusion(host(nested)), "excluded", "the anchored nested rule")
  assert.equal(await checkDesignFolderExclusion(host(directory)), "missing", "the top's own rule is separate")
  assert.deepEqual(await readFile(file), written)

  const outside = path.join(root, "check-outside")
  await mkdir(outside)
  assert.equal(await checkDesignFolderExclusion(host(outside)), "not-repository")
  const failing: ExcludeGit = async () => { throw Object.assign(new Error("spawn"), { code: "ENOENT" }) }
  assert.equal(await checkDesignFolderExclusion(host(directory), failing), "unavailable")
})

test("reuses the existing # codenomad header", async () => {
  const directory = await repository("header")
  const file = excludeFile(directory)
  await writeFile(file, "# codenomad\n.codenomad/worktrees/")
  assert.equal(await excludeDesignFolder(host(directory)), "excluded")
  assert.equal(await readFile(file, "utf8"), "# codenomad\n.codenomad/worktrees/\n.codenomad/design/\n")
})

test("the worktree and design entries share one header through the same writer", async () => {
  const directory = await repository("shared-writer")
  await writeFile(excludeFile(directory), "foreign\n")
  await ensureCodenomadGitExclude(directory)
  assert.equal(await excludeDesignFolder(host(directory)), "excluded")
  await ensureCodenomadGitExclude(directory)
  assert.equal(await readFile(excludeFile(directory), "utf8"), "foreign\n\n# codenomad\n.codenomad/worktrees/\n.codenomad/design/\n")
})

async function designImage(location: string) {
  await mkdir(path.join(location, ".codenomad", "design", "subject"), { recursive: true })
  await writeFile(path.join(location, ".codenomad", "design", "subject", "icon.png"), "x")
}

test("a nested Location gets a rule anchored at its own folder, in the main and a linked worktree", async () => {
  const directory = await repository("nested-main")
  const nested = path.join(directory, "packages", "feature [x]")
  await mkdir(nested, { recursive: true })
  assert.equal(await excludeDesignFolder(host(nested)), "excluded")
  assert.match(await readFile(excludeFile(directory), "utf8"), /^\/packages\/feature \\\[x\]\/\.codenomad\/design\/$/m)
  await designImage(nested)
  assert.equal(git(directory, "status", "--porcelain", "--untracked-files=all"), "")
  // Only that Location's folder: the repository root keeps its own rule.
  await designImage(directory)
  assert.notEqual(git(directory, "status", "--porcelain", "--untracked-files=all"), "")
  assert.equal(await excludeDesignFolder(host(directory)), "excluded")
  assert.equal(git(directory, "status", "--porcelain", "--untracked-files=all"), "")

  const linked = path.join(root, "nested-linked")
  git(directory, "worktree", "add", "-b", "nested-linked", linked)
  const linkedNested = path.join(linked, "packages", "feature [x]")
  await mkdir(linkedNested, { recursive: true })
  assert.equal(await excludeDesignFolder(host(linkedNested)), "excluded")
  await designImage(linkedNested)
  await designImage(linked)
  assert.equal(git(linked, "status", "--porcelain", "--untracked-files=all"), "", "the common file covers each worktree's top and nested Location")
})

test("existing lines match as Git reads them: leading spaces count, trailing spaces do not", async () => {
  const leading = await repository("leading-space")
  await writeFile(excludeFile(leading), " .codenomad/design/\n")
  assert.equal(await excludeDesignFolder(host(leading)), "excluded")
  assert.equal(await readFile(excludeFile(leading), "utf8"), " .codenomad/design/\n\n# codenomad\n.codenomad/design/\n")
  await designImage(leading)
  assert.equal(git(leading, "status", "--porcelain", "--untracked-files=all"), "")

  const trailing = await repository("trailing-space")
  const existing = "# codenomad\r\n.codenomad/design/   \r\n"
  await writeFile(excludeFile(trailing), existing)
  assert.equal(await excludeDesignFolder(host(trailing)), "excluded")
  assert.equal(await readFile(excludeFile(trailing), "utf8"), existing, "an equivalent rule is kept as is")
  await designImage(trailing)
  assert.equal(git(trailing, "status", "--porcelain", "--untracked-files=all"), "")

  // The worktree-creation entry goes through the same reading.
  await writeFile(excludeFile(trailing), "\t.codenomad/worktrees/\n")
  await ensureCodenomadGitExclude(trailing)
  assert.equal(await readFile(excludeFile(trailing), "utf8"), "\t.codenomad/worktrees/\n\n# codenomad\n.codenomad/worktrees/\n")
})

test("concurrent calls append once", async () => {
  const directory = await repository("concurrent")
  const results = await Promise.all([excludeDesignFolder(host(directory)), excludeDesignFolder(host(directory)), excludeDesignFolder(host(directory))])
  assert.deepEqual(results, ["excluded", "excluded", "excluded"])
  assert.equal(count(await readFile(excludeFile(directory), "utf8")), 1)
})

test("a linked worktree is covered by the common exclude file", async () => {
  const directory = await repository("linked-main")
  const linked = path.join(root, "linked-worktree")
  git(directory, "worktree", "add", "-b", "linked", linked)
  assert.equal(await excludeDesignFolder(host(linked)), "excluded")
  assert.equal(excludeFile(linked), excludeFile(directory))
  assert.equal(count(await readFile(excludeFile(directory), "utf8")), 1)
  await mkdir(path.join(linked, ".codenomad", "design"), { recursive: true })
  await writeFile(path.join(linked, ".codenomad", "design", "x.png"), "x")
  assert.equal(git(linked, "status", "--porcelain"), "")
})

test("outside a repository nothing is written", async () => {
  const directory = path.join(root, "not-a-repository")
  await mkdir(directory)
  assert.equal(await excludeDesignFolder(host(directory)), "not-repository")
  assert.equal(existsSync(path.join(directory, ".git")), false)
  assert.equal(existsSync(path.join(directory, ".codenomad")), false)
})

test("discovery failures are unavailable, never 'no repository'", async () => {
  const unreadable = path.join(root, "broken-pointer")
  await mkdir(unreadable)
  await writeFile(path.join(unreadable, ".git"), `gitdir: ${path.join(root, "missing-gitdir")}\n`)
  assert.equal(await excludeDesignFolder(host(unreadable)), "unavailable")
  assert.equal(existsSync(path.join(root, "missing-gitdir")), false)

  const malformed = path.join(root, "malformed-pointer")
  await mkdir(malformed)
  await writeFile(path.join(malformed, ".git"), "not a pointer\n")
  assert.equal(await excludeDesignFolder(host(malformed)), "unavailable")

  assert.equal(await excludeDesignFolder(host(path.join(root, "deleted-location"))), "unavailable")

  const missingGit: ExcludeGit = async () => { throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }) }
  assert.equal(await excludeDesignFolder(host(root), missingGit), "unavailable")
})

test("a location deleted during the operation writes nothing", async () => {
  const directory = await repository("vanishing")
  const file = excludeFile(directory)
  const before = await readFile(file)
  const removing: ExcludeGit = async (target, args) => {
    const output = git(target.directory, ...args)
    await rm(directory, { recursive: true, force: true })
    return output
  }
  assert.equal(await excludeDesignFolder(host(directory), removing), "unavailable")
  assert.equal(existsSync(path.join(directory, ".git")), false, "deleted Git metadata is never recreated")
  assert.ok(before.length > 0)
})

test("a WSL location is resolved by the distro's Git, then written through the host translation", async () => {
  // A worktree created in WSL: Git follows its Linux `gitdir:` pointer and names the common file.
  const share = path.join(root, "wsl-share")
  await mkdir(path.join(share, "home", "user", "repo", ".git", "info"), { recursive: true })
  await mkdir(path.join(share, "home", "user", "linked"), { recursive: true })
  const calls: Array<{ target: ExcludeTarget; args: string[] }> = []
  const wslGit: ExcludeGit = async (target, args) => {
    calls.push({ target, args })
    // `--show-prefix` then `--git-path`, one line each; the prefix line is empty at a worktree top.
    return target.directory === "/home/user/repo" ? "\n.git/info/exclude"
      : target.directory === "/home/user/repo/app" ? "app/\n/home/user/repo/.git/info/exclude" : "\n/home/user/repo/.git/info/exclude"
  }
  const translated: string[] = []
  const target = (directory: string): ExcludeTarget => ({
    directory, distro: "Ubuntu",
    toHost: async servicePath => {
      translated.push(servicePath)
      return path.join(share, ...servicePath.split("/").filter(Boolean))
    },
  })
  assert.equal(await excludeDesignFolder(target("/home/user/repo"), wslGit), "excluded")
  assert.equal(await excludeDesignFolder(target("/home/user/linked"), wslGit), "excluded")
  await mkdir(path.join(share, "home", "user", "repo", "app"))
  assert.equal(await excludeDesignFolder(target("/home/user/repo/app"), wslGit), "excluded")
  assert.deepEqual(calls.map(call => [call.target.distro, call.target.directory, ...call.args]), [
    ["Ubuntu", "/home/user/repo", "rev-parse", "--show-prefix", "--git-path", "info/exclude"],
    ["Ubuntu", "/home/user/linked", "rev-parse", "--show-prefix", "--git-path", "info/exclude"],
    ["Ubuntu", "/home/user/repo/app", "rev-parse", "--show-prefix", "--git-path", "info/exclude"],
  ])
  assert.ok(translated.includes("/home/user/repo/.git/info/exclude"), "the Linux path is translated, never given to Windows directly")
  assert.equal(await readFile(path.join(share, "home", "user", "repo", ".git", "info", "exclude"), "utf8"),
    "# codenomad\n.codenomad/design/\n/app/.codenomad/design/\n")

  const untranslatable = { ...target("/home/user/repo"), toHost: async () => undefined }
  assert.equal(await excludeDesignFolder(untranslatable, wslGit), "unavailable")
})

// Real distro Git and wslpath, on a throwaway repository and a linked worktree created in WSL.
const distro = process.env.CODENOMAD_TEST_WSL_DISTRO
test("WSL: a project and a worktree created in the distro are excluded through its Git", { skip: process.platform !== "win32" || !distro }, async () => {
  const wsl = (...args: string[]) => execFileSync("wsl.exe", ["--distribution", distro!, "--exec", ...args], { encoding: "utf8", windowsHide: true }).trim()
  const base = wsl("mktemp", "-d", "/tmp/codenomad-design-exclude-XXXXXX")
  try {
    const repo = `${base}/repo`, linked = `${base}/linked`
    wsl("sh", "-c", `git init -q -b main "${repo}" && cd "${repo}" && git -c user.name=f -c user.email=f@example.invalid commit -q --allow-empty -m i && git worktree add -q -b linked "${linked}" && printf 'foreign\\n' > .git/info/exclude`)
    const target = (directory: string): ExcludeTarget => ({ directory, distro, toHost: async servicePath => wsl("wslpath", "-aw", servicePath) })
    assert.equal(await checkDesignFolderExclusion(target(linked)), "missing")
    assert.equal(wsl("cat", `${repo}/.git/info/exclude`), "foreign", "the check writes nothing")
    assert.equal(await excludeDesignFolder(target(linked)), "excluded")
    assert.equal(await checkDesignFolderExclusion(target(repo)), "excluded", "the linked worktree's rule is the common file's")
    assert.equal(await excludeDesignFolder(target(repo)), "excluded")
    assert.equal(wsl("cat", `${repo}/.git/info/exclude`), "foreign\n\n# codenomad\n.codenomad/design/")
    wsl("sh", "-c", `mkdir -p "${linked}/.codenomad/design/s" && printf x > "${linked}/.codenomad/design/s/a.png"`)
    assert.equal(wsl("git", "-C", linked, "status", "--porcelain"), "")
    wsl("mkdir", "-p", `${linked}/packages/app`)
    assert.equal(await excludeDesignFolder(target(`${linked}/packages/app`)), "excluded")
    wsl("sh", "-c", `mkdir -p "${linked}/packages/app/.codenomad/design/s" && printf x > "${linked}/packages/app/.codenomad/design/s/a.png"`)
    assert.equal(wsl("git", "-C", linked, "status", "--porcelain", "--untracked-files=all"), "")
    assert.match(wsl("cat", `${repo}/.git/info/exclude`), /^\/packages\/app\/\.codenomad\/design\/$/m)
    assert.equal(await excludeDesignFolder(target(base)), "not-repository")
    wsl("sh", "-c", `printf 'gitdir: /nonexistent\\n' > "${base}/.git"`)
    assert.equal(await excludeDesignFolder(target(base)), "unavailable")
  } finally { wsl("rm", "-rf", "--", base) }
})
