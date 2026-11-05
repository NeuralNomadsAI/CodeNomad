import assert from "node:assert/strict"
import { mkdir, symlink } from "node:fs/promises"
import path from "node:path"
import { tsImport } from "tsx/esm/api"

const { bundledNpm } = await tsImport("../packages/server/src/opencode-update/npm-runtime.ts", import.meta.url)

// Select an actual packaged Electron executable and npm-only resources, never a renamed Node copy.
export async function fixtureRuntime(root) {
  const electron = process.env.CODENOMAD_FIXTURE_ELECTRON === "1"
  const node = process.env.CODENOMAD_FIXTURE_NODE || process.execPath
  const resources = process.env.CODENOMAD_FIXTURE_RESOURCES
  if (electron) assert.ok(resources && process.env.CODENOMAD_FIXTURE_NODE, "Electron fixture requires NODE and RESOURCES")
  const npm = bundledNpm(node, resources)
  assert.ok(npm, "Fixture requires bundled npm")
  const tools = path.join(root, "tools")
  await mkdir(tools, { recursive: true })
  if (process.platform !== "win32") await symlink("/bin/sh", path.join(tools, "sh"))
  return { node, npm, electron, env: electron ? { ELECTRON_RUN_AS_NODE: "1" } : {},
    path: process.platform === "win32" ? `${process.env.SystemRoot}/System32`
      : electron ? tools : `${path.dirname(node)}:/usr/bin:/bin` }
}
