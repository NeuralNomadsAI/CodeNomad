import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { createFixtureCache } from "./fixture-cache"

test("concurrent browser fixture caches are distinct and disposal only removes the owned cache", async t => {
  const [first, second] = await Promise.all([createFixtureCache(), createFixtureCache()])
  t.after(async () => { await first.dispose(); await second.dispose() })
  assert.notEqual(first.cacheDir, second.cacheDir)
  const marker = "fixture-ownership"
  await Promise.all([
    writeFile(path.join(first.cacheDir, marker), "first"),
    writeFile(path.join(second.cacheDir, marker), "second"),
  ])
  await first.dispose()
  await assert.rejects(readFile(path.join(first.cacheDir, marker)), { code: "ENOENT" })
  assert.equal(await readFile(path.join(second.cacheDir, marker), "utf8"), "second")
  await first.dispose() // Exact cleanup retries remain safe.
})
