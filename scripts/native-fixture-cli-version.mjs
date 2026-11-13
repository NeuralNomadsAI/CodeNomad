import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { fixtureEnvironment, fixtureParent } from "./native-product-fixture.mjs"

export async function fixtureCliVersion(cli) {
  assert(path.isAbsolute(cli), "Pass an absolute isolated CLI")
  const root = await mkdtemp(path.join(await fixtureParent(), "cli-version-"))
  try {
    const env = await fixtureEnvironment(root, { OPENCODE_CONFIG_DIR: root, OPENCODE_DB: path.join(root, "fixture.db"),
      OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1" })
    const output = execFileSync(cli, ["--version"], { cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 15000 }).trim()
    const match = /^(?:opencode v)?(\d+\.\d+\.\d+(?:-[\w.-]+)?)$/.exec(output)
    assert(match, "Unexpected isolated CLI version output")
    return match[1]
  } finally { await rm(root, { recursive: true, force: true }) }
}
