import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { setImmediate as nextTurn } from "node:timers/promises"
import type { OpenCodeClient } from "@opencode/client"
import { listNativeWorktrees } from "../native-worktrees"

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test("failed native inventory stops admission and drains owned reads before returning the original denial", async t => {
  const parent = process.platform === "win32" ? path.join(tmpdir(), "opencode") : tmpdir()
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(path.join(parent, "worktree-custody-"))
  const repo = path.join(root, "main")
  const git = (directory: string, ...args: string[]) => execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim()
  const peersStarted = gate()
  const failureStarted = gate()
  const releasePeers = gate()
  const readsDrained = gate()
  const originalError = Object.freeze(new Error("first owned read denied"))
  const laterError = new Error("later owned read denied")
  let scanning = false, cleaning = false, admitted = 0, active = 0, peak = 0, refreshes = 0
  let outcome: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let settled = false, published = false, rejection: unknown
  try {
    git(root, "init", "--initial-branch=main", repo)
    git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial")
    for (let index = 0; index < 9; index++) git(repo, "worktree", "add", "--detach", path.join(root, `linked-${index}`))
    // Same isolated native transport as native-worktree-fixture; Git identity and the catalogue stay real.
    const client = {
      location: { get: async ({ location }: { location: { directory: string } }) => {
        const directory = git(location.directory, "rev-parse", "--show-toplevel")
        const common = git(directory, "rev-parse", "--path-format=absolute", "--git-common-dir")
        return { directory: location.directory, project: { id: "fixture", directory, canonical: path.dirname(common) } }
      } },
      worktree: {
        refresh: async () => { refreshes++ },
        list: async () => {
          const entries = git(repo, "worktree", "list", "--porcelain", "-z").split("\0")
            .filter(field => field.startsWith("worktree ")).map(field => ({ directory: field.slice(9) }))
          assert.equal(entries.length, 10)
          scanning = true
          return entries
        },
      },
    } as unknown as OpenCodeClient
    outcome = listNativeWorktrees({ client, workspacePath: repo, location: { directory: repo },
      toHost: async directory => {
        if (!scanning) return directory
        const index = ++admitted
        peak = Math.max(peak, ++active)
        if (admitted === 8) peersStarted.resolve()
        try {
          if (index === 1) {
            await peersStarted.promise
            failureStarted.resolve()
            throw originalError
          }
          await releasePeers.promise
          if (cleaning || index === 2) throw laterError
          return directory
        } finally {
          if (--active === 0) readsDrained.resolve()
        }
      },
    }, { refresh: false }).then(() => { settled = true; published = true }, error => { settled = true; rejection = error })
    await Promise.race([
      failureStarted.promise,
      outcome.then(() => { throw new Error("Native scan settled before the held peer reads started") }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Native scan peer-read setup timed out")), 30_000)
      }),
    ])
    clearTimeout(timer)
    await nextTurn()
    assert.equal(settled, false, "a denial must retain custody of already-admitted peer reads")
    assert.equal(published, false)
    assert.equal(admitted, 8)
    assert.equal(active, 7)
    assert.equal(peak, 8)
    assert.equal(refreshes, 0, "registered-only inventory must not refresh native strategy")
    releasePeers.resolve()
    await outcome
    assert.equal(rejection, originalError, "draining a later rejection must not replace the first denial")
    assert.equal(published, false, "failed scans never publish a partial inventory")
    assert.equal(admitted, 8, "completed peers must not admit remaining entries after failure")
    assert.equal(active, 0)
  } finally {
    // Even the pre-fix negative run keeps custody: released peers fail before touching the filesystem.
    clearTimeout(timer)
    cleaning = true
    peersStarted.resolve()
    releasePeers.resolve()
    if (active) await readsDrained.promise
    await outcome
    await rm(root, { recursive: true, force: true })
    t.diagnostic(`Owned fixture removed after admitted reads settled: ${root}`)
  }
})
