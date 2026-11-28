import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { brotliDecompressSync, gunzipSync } from "node:zlib"
import { precompressUi } from "./precompress-ui.mjs"

test("precompresses a staged UI without changing original or small files", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "precompressed-ui-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const assets = path.join(root, "assets")
  await mkdir(assets)
  const asset = path.join(assets, "app.js")
  const raw = Buffer.from("// static data\n".repeat(256))
  await writeFile(asset, raw)
  await writeFile(path.join(assets, "tiny.js"), "let x=0")
  await precompressUi(root)
  assert.deepEqual((await readdir(assets)).sort(), ["app.js", "app.js.br", "app.js.gz", "tiny.js"])
  assert.deepEqual(await readFile(asset), raw)
  assert.deepEqual(brotliDecompressSync(await readFile(`${asset}.br`)), raw)
  assert.deepEqual(gunzipSync(await readFile(`${asset}.gz`)), raw)
})

test("a compatibility archive can keep HTML only at its protected original path", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "precompressed-compat-ui-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const text = "<!-- static data -->".repeat(256)
  await writeFile(path.join(root, "INDEX.HTML"), text)
  await writeFile(path.join(root, "INDEX.HTML.br"), "staged sidecar")
  await writeFile(path.join(root, "books.js"), text)
  await precompressUi(root, { includeHtml: false })
  assert.deepEqual((await readdir(root)).sort(), ["INDEX.HTML", "books.js", "books.js.br", "books.js.gz"])
})
