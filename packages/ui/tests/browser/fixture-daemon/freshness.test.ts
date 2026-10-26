import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import { newestSourceMtime } from "./freshness"

let root: string
before(async () => { root = await mkdtemp(path.join(tmpdir(), "freshness-")) })
after(async () => { await rm(root, { recursive: true, force: true }) })

test("the newest source mtime follows deep files and ignores noise directories", async () => {
  const old = new Date(Date.now() - 60_000)
  await mkdir(path.join(root, "fixtures/deep"), { recursive: true })
  await mkdir(path.join(root, "node_modules/dep"), { recursive: true })
  await mkdir(path.join(root, ".git"), { recursive: true })
  await writeFile(path.join(root, "fixtures/a.tsx"), "a")
  await writeFile(path.join(root, "fixtures/deep/b.tsx"), "b")
  await writeFile(path.join(root, "node_modules/dep/c.js"), "c")
  await writeFile(path.join(root, ".git/d.txt"), "d")
  // Normalize every written file to a known old instant first.
  for (const file of ["fixtures/a.tsx", "fixtures/deep/b.tsx", "node_modules/dep/c.js", ".git/d.txt"]) {
    await utimes(path.join(root, file), old, old)
  }
  const baseline = await newestSourceMtime([root])
  assert.equal(baseline, old.getTime(), "the newest tracked mtime is the deepest fixture file")

  const newer = new Date(Date.now() + 5_000)
  await utimes(path.join(root, "fixtures/deep/b.tsx"), newer, newer)
  assert.equal(await newestSourceMtime([root]), newer.getTime(), "editing one source file moves the fingerprint")

  const dependencyNoise = new Date(Date.now() + 10_000)
  await utimes(path.join(root, "node_modules/dep/c.js"), dependencyNoise, dependencyNoise)
  await utimes(path.join(root, ".git/d.txt"), dependencyNoise, dependencyNoise)
  assert.equal(await newestSourceMtime([root]), newer.getTime(), "node_modules and dot directories never count")
})

test("generated public asset directories never count, but real source edits do", async () => {
  const tree = await mkdtemp(path.join(tmpdir(), "freshness-public-"))
  try {
    const base = new Date(Date.now() - 60_000)
    await mkdir(path.join(tree, "src/renderer/public/monaco/vs"), { recursive: true })
    await mkdir(path.join(tree, "src/renderer"), { recursive: true })
    await writeFile(path.join(tree, "src/renderer/app.tsx"), "app")
    await writeFile(path.join(tree, "src/renderer/public/monaco/vs/loader.js"), "loader")
    for (const file of ["src/renderer/app.tsx", "src/renderer/public/monaco/vs/loader.js"]) {
      await utimes(path.join(tree, file), base, base)
    }
    const baseline = await newestSourceMtime([tree])
    assert.equal(baseline, base.getTime(), "only the real source counts")

    // The git fixtures copy Monaco's assets into src/renderer/public at run
    // time — discovered on CI, where that copy retired the shared daemon and
    // degraded every later borrower to a private one. Asset copies landing
    // after a daemon's start must not invalidate it.
    const assetCopy = new Date(Date.now() + 5_000)
    await writeFile(path.join(tree, "src/renderer/public/monaco/vs/editor.js"), "editor")
    await utimes(path.join(tree, "src/renderer/public/monaco/vs/editor.js"), assetCopy, assetCopy)
    await utimes(path.join(tree, "src/renderer/public/monaco/vs/loader.js"), assetCopy, assetCopy)
    assert.equal(await newestSourceMtime([tree]), baseline, "a generated public asset copy is invisible")

    const sourceEdit = new Date(Date.now() + 8_000)
    await utimes(path.join(tree, "src/renderer/app.tsx"), sourceEdit, sourceEdit)
    assert.equal(await newestSourceMtime([tree]), sourceEdit.getTime(), "a real source edit still counts")
  } finally { await rm(tree, { recursive: true, force: true }) }
})

test("an empty or missing tree yields 0 rather than throwing", async () => {
  assert.equal(await newestSourceMtime([]), 0)
  assert.equal(await newestSourceMtime([path.join(root, "does-not-exist")]), 0)
})
