import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"

const root = fileURLToPath(new URL("../", import.meta.url))

test("English help builds standalone pages with working local links, assets, and anchors", async (ctx) => {
  const output = await mkdtemp(join(tmpdir(), "codenomad-help-"))
  ctx.after(() => rm(output, { recursive: true, force: true }))
  execFileSync(process.execPath, [resolve(root, "scripts/build-help.mjs"), output], { cwd: root })
  const pages = (await readdir(output)).filter((name) => name.endsWith(".html"))
  assert.equal(pages.length, 7)
  for (const page of pages) {
    const html = await readFile(join(output, page), "utf8")
    assert.match(html, /<html lang="en">/)
    assert.equal((html.match(/<h1 /g) ?? []).length, 1, page)
    assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1, page)
    assert.match(html, new RegExp(`href="${page}" aria-current="page"`))
    assert.ok(!html.includes("<script"), "no client-side runtime needed")
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1])
    assert.equal(ids.length, new Set(ids).size, "unique anchors")
    for (const [, url] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      if (url.startsWith("https://")) continue
      assert.ok(!url.startsWith("/"), `project Pages links must stay relative: ${url}`)
      assert.ok(!url.includes(".md"), `Markdown link not converted: ${url}`)
      const [path, fragment] = url.split("#")
      const target = path ? await readFile(join(output, path), "utf8") : html
      if (fragment) assert.ok(target.includes(`id="${fragment}"`), `broken anchor: ${page} → ${url}`)
    }
  }
})
