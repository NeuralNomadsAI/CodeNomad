import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { withProductRuntime } from "./native-product-fixture.mjs"

let version = "1.0.0", base
const archives = new Map()
const registry = createServer((req, res) => {
  if (req.url.startsWith("/fixture-plugin/-/")) {
    const archive = archives.get(req.url.split("/").at(-1))
    res.writeHead(archive ? 200 : 404, { "Content-Type": "application/octet-stream" }); res.end(archive); return
  }
  if (req.url.split("?")[0] !== "/fixture-plugin") { res.writeHead(404); res.end(); return }
  const versions = Object.fromEntries(["1.0.0", "1.1.0"].map(v => [v, { name: "fixture-plugin", version: v,
    dist: { tarball: `${base}/fixture-plugin/-/${v}.tgz` } }]))
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify({ name: "fixture-plugin", "dist-tags": { latest: version }, versions }))
})
await new Promise(resolve => registry.listen(0, "127.0.0.1", resolve))
base = `http://127.0.0.1:${registry.address().port}`
try {
  await withProductRuntime(process.argv[2], async ({ root }) => {
    await writeFile(path.join(root, ".npmrc"), `registry=${base}\naudit=false\nfund=false\n`)
    for (const v of ["1.0.0", "1.1.0"]) {
      const directory = path.join(root, v), pkg = path.join(directory, "package")
      await mkdir(pkg, { recursive: true })
      await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "fixture-plugin", version: v, type: "module", exports: { ".": "./index.js" } }))
      await writeFile(path.join(pkg, "index.js"), 'export default { id: "fixture.package", setup() {} }\n')
      const tarball = path.join(root, `${v}.tgz`)
      const tar = spawnSync("tar", ["-czf", tarball, "-C", directory, "package"], { encoding: "utf8" })
      assert.equal(tar.status, 0, tar.stderr)
      archives.set(`${v}.tgz`, await readFile(tarball))
    }
    return { plugins: ["fixture-plugin@latest"] }
  }, async ({ client, root }) => {
    const location = { directory: root }
    await client.location.get({ location })
    const waitFor = async predicate => {
      const deadline = Date.now() + 60_000
      let info
      do {
        info = (await client.plugin.list({ location })).data.find(item => item.source.type === "package" && item.source.target === "fixture-plugin@latest")
        if (info && predicate(info)) return info
        await delay(100)
      } while (Date.now() < deadline)
      assert.fail(`Native package state did not settle: ${JSON.stringify(info)}`)
    }
    await waitFor(info => info.state.status === "active" && info.source.version === "1.0.0")
    version = "1.1.0"
    const checked = await client.plugin.check({ location, target: "fixture-plugin@latest" })
    assert.equal(checked.data.find(item => item.source.type === "package").source.outdated, true)
    await assert.rejects(client.plugin.update({ location, targets: ["not-in-inventory"] }))
    await client.plugin.update({ location, targets: ["fixture-plugin@latest"] })
    await waitFor(info => info.state.status === "active" && info.source.version === "1.1.0" && !info.source.updating)
    console.log("PASS isolated registry package check/update, unknown-target rejection and native live reload")
  })
} finally { registry.closeAllConnections(); await new Promise(resolve => registry.close(resolve)) }
