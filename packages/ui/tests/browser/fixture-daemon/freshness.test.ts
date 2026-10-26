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

test("an empty or missing tree yields 0 rather than throwing", async () => {
  assert.equal(await newestSourceMtime([]), 0)
  assert.equal(await newestSourceMtime([path.join(root, "does-not-exist")]), 0)
})
