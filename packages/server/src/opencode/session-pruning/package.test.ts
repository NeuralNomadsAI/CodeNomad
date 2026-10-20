import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

test("every packed plugin entrypoint resolves without sibling checkout sources", async () => {
  const source = fileURLToPath(new URL("./", import.meta.url))
  const temporaryRoot = path.join(os.tmpdir(), "opencode")
  await mkdir(temporaryRoot, { recursive: true })
  const isolated = await mkdtemp(path.join(temporaryRoot, "pruning-package-"))
  try {
    const output = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", [
      "pack", "--dry-run", "--json", "--ignore-scripts",
    ], { cwd: source, encoding: "utf8", shell: process.platform === "win32" })
    const [archive] = JSON.parse(output) as { files: { path: string }[] }[]
    for (const file of archive.files) {
      const destination = path.join(isolated, file.path)
      await mkdir(path.dirname(destination), { recursive: true })
      await copyFile(path.join(source, file.path), destination)
    }
    const manifest = JSON.parse(await readFile(path.join(isolated, "package.json"), "utf8"))
    const result = await build({
      absWorkingDir: isolated,
      entryPoints: Object.values(manifest.exports) as string[],
      outdir: "dist", bundle: true, write: false, platform: "node", format: "esm",
      packages: "external", logLevel: "silent", metafile: true,
    })
    assert.equal(result.outputFiles.length, Object.keys(manifest.exports).length)
    // Installed copies resolve bare imports from their own manifest, not from hoisting.
    const imported = Object.values(result.metafile.outputs).flatMap(output => output.imports)
      .filter(entry => entry.external && !entry.path.startsWith("node:"))
      .map(entry => entry.path.split("/").slice(0, entry.path.startsWith("@") ? 2 : 1).join("/"))
    for (const name of new Set(imported)) assert.ok(manifest.dependencies?.[name], `${name} is a declared dependency`)
  } finally {
    await rm(isolated, { recursive: true, force: true })
  }
})
