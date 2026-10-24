import assert from "node:assert/strict"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { nativePluginBuild } from "./native-plugin-build.mjs"

test("native plugin builds never embed a second Effect runtime or OpenCode adapter", async () => {
  for (const entry of ["session-pruning/desktop-plugin", "automation/desktop-plugin", "missions/managed-owner-plugin"]) {
    const result = await build({ ...nativePluginBuild,
      entryPoints: [fileURLToPath(new URL(`../src/opencode/${entry}.ts`, import.meta.url))],
      write: false, metafile: true })
    const inputs = Object.keys(result.metafile.inputs).map(value => value.replaceAll("\\", "/"))
    assert.equal(inputs.some(value => /node_modules\/(?:effect|@opencode\/plugin)\//.test(value)), false, entry)
    assert(result.outputFiles[0].text.includes("desktopPlugin"), entry)
  }
})
