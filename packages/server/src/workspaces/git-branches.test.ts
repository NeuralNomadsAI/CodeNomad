import assert from "node:assert/strict"
import test from "node:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { getLocalGitBranches } from "./git-branches"

test("local ref choices include unchecked-out branches, exclude remotes and refuse over-bound lists", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mission-local-refs-"))
  const git = (...args: string[]) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", windowsHide: true })
  try {
    git("init", "--initial-branch=main")
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "Initial")
    git("branch", "not-checked-out"); git("update-ref", "refs/remotes/origin/remote-only", "HEAD")
    assert.deepEqual(await getLocalGitBranches(directory), ["refs/heads/main", "refs/heads/not-checked-out"])
    const inherited = process.env.GIT_DIR
    try {
      process.env.GIT_DIR = path.join(directory, "foreign-missing-repository")
      assert.deepEqual(await getLocalGitBranches(directory), ["refs/heads/main", "refs/heads/not-checked-out"], "inherited repository redirection cannot escape the owned directory")
    } finally { if (inherited === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = inherited }
    for (let index = 0; index < 199; index++) git("branch", `extra-${index}`)
    await assert.rejects(getLocalGitBranches(directory), /bound/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
