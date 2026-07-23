import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { searchWorkspaceFiles } from "../search"
import { getWorkspaceCandidates } from "../search-cache"

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-search-"))

after(() => fs.rmSync(workspace, { recursive: true, force: true }))

test("finds a matching file after more than 8000 non-matching entries", () => {
  fs.mkdirSync(path.join(workspace, "a"))
  fs.mkdirSync(path.join(workspace, "b"))

  const [targetDirName, fillerDirName] = fs.readdirSync(workspace)
  const fillerDir = path.join(workspace, fillerDirName)
  const targetDir = path.join(workspace, targetDirName)

  for (let index = 0; index < 8_001; index += 1) {
    fs.writeFileSync(path.join(fillerDir, `filler-${index}.txt`), "")
  }
  fs.writeFileSync(path.join(targetDir, "unique-search-target.txt"), "")

  const results = searchWorkspaceFiles(workspace, "unique-search-target", {
    type: "file",
    refresh: true,
  })

  assert.equal(results.some((entry) => entry.name === "unique-search-target.txt"), true)

  searchWorkspaceFiles(workspace, "filler", { type: "file", refresh: true })
  assert.equal(getWorkspaceCandidates(workspace, "file\0filler")?.length, 8_000)
})

test("does not revisit directory links", () => {
  const cyclicWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-search-cycle-"))
  try {
    fs.symlinkSync(cyclicWorkspace, path.join(cyclicWorkspace, "cycle"), process.platform === "win32" ? "junction" : "dir")
    assert.deepEqual(searchWorkspaceFiles(cyclicWorkspace, "not-present", { refresh: true }), [])
  } finally {
    fs.rmSync(cyclicWorkspace, { recursive: true, force: true })
  }
})

test("indexes both real and linked directory paths", () => {
  const linkedWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-search-link-"))
  try {
    const realDirectory = path.join(linkedWorkspace, "b")
    fs.mkdirSync(realDirectory)
    fs.writeFileSync(path.join(realDirectory, "needle.txt"), "")
    fs.symlinkSync(realDirectory, path.join(linkedWorkspace, "a"), process.platform === "win32" ? "junction" : "dir")

    const linkedResults = searchWorkspaceFiles(linkedWorkspace, "a/needle", { type: "file", refresh: true })
    const realResults = searchWorkspaceFiles(linkedWorkspace, "b/needle", { type: "file", refresh: true })

    assert.equal(linkedResults.some((entry) => entry.path === "a/needle.txt"), true)
    assert.equal(realResults.some((entry) => entry.path === "b/needle.txt"), true)
  } finally {
    fs.rmSync(linkedWorkspace, { recursive: true, force: true })
  }
})
