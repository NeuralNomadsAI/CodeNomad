// Native Git initialization fixture. Invoke with an absolute CLI path:
//   node scripts/test-git-init-native.mjs <absolute opencode executable>
// runIsolated starts a private daemon with its own HOME/XDG/config/database and
// uses synthetic folders only; it never touches the shared daemon.
import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { tsImport } from "tsx/esm/api"
import { runIsolated } from "./test-opencode-location-native.mjs"

export async function testNativeGitInit({ client, root }) {
  const { initializeNativeGit, GitInitError } = await tsImport("../packages/server/src/workspaces/git-init.ts", import.meta.url)
  const { listNativeWorktrees } = await tsImport("../packages/server/src/workspaces/native-worktrees.ts", import.meta.url)
  const { getWorktreeGitStatus } = await tsImport("../packages/server/src/workspaces/git-status.ts", import.meta.url)
  const { getGitHistory } = await tsImport("../packages/server/src/workspaces/git-history.ts", import.meta.url)
  const parent = path.join(root, "markerless-parent")
  const folder = path.join(parent, "opened")
  await mkdir(folder, { recursive: true })
  await writeFile(path.join(folder, "notes.txt"), "synthetic fixture\n")
  const context = { client, location: { directory: folder }, workspacePath: folder, toHost: async directory => directory }

  // A markerless child resolves to its own project directory, never its parent.
  const before = await client.location.get({ location: { directory: folder } })
  assert.equal(path.resolve(before.project.directory), path.resolve(folder))
  const session = await client.session.create({ location: { directory: folder } })
  assert.equal((await listNativeWorktrees(context)).isGitRepo, false)

  await initializeNativeGit(context)
  const after = await client.location.get({ location: { directory: folder } })
  assert.equal(path.resolve(after.project.directory), path.resolve(folder))
  // The native project identity changes with the repository; sessions follow it.
  const moved = await client.session.get({ sessionID: session.id })
  assert.equal(moved.projectID, after.project.id)
  assert.ok((await client.session.list({ directory: folder })).data.some(entry => entry.id === session.id))

  const catalogue = await listNativeWorktrees(context)
  assert.equal(catalogue.isGitRepo, true)
  assert.deepEqual(catalogue.worktrees.map(entry => entry.kind), ["root"])
  const status = await getWorktreeGitStatus({ workspaceFolder: folder })
  assert.ok(status.some(entry => entry.path === "notes.txt"), "Changes lists the untracked file of the unborn repository")
  assert.deepEqual((await getGitHistory(folder)).commits, [])

  await assert.rejects(initializeNativeGit(context), error => error instanceof GitInitError && error.code === "git_init_repository_exists")
  await client.session.remove({ sessionID: session.id })
  console.log("PASS: native vcs.init on the exact markerless folder, project/session continuity, unborn inventory/status/history and repeat refusal")
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runIsolated(process.argv[2], testNativeGitInit)
