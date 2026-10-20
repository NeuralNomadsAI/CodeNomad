import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { clearFixtureGitEnvironment } from "../native-fixture-guards.mjs"

// The CLI is the first argument; otherwise the user's shared npm installation on Windows.
export const ASSIGNED_CLI = path.resolve(process.argv[2]
  ?? path.join(process.env.APPDATA ?? os.homedir(), "npm/node_modules/@opencode/cli/bin/opencode.exe"))
export async function privateRoot(cli) {
  assert.equal(path.resolve(cli).toLowerCase(), path.resolve(ASSIGNED_CLI).toLowerCase(), "Only assigned private serve CLI")
  const temp = path.join(os.tmpdir(), "opencode")
  await mkdir(temp, { recursive: true })
  const root = await mkdtemp(path.join(temp, "missions-child-environment-"))
  const config = path.join(root, "config"), project = path.join(root, "project")
  for (const directory of [config, project]) await mkdir(directory)
  clearFixtureGitEnvironment()
  for (const key of Object.keys(process.env)) if (/^(OPENCODE_|CODENOMAD_|XDG_)/i.test(key)) delete process.env[key]
  for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) process.env[key] = path.join(root, key)
  Object.assign(process.env, { HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, OPENCODE_TEST_HOME: root,
    XDG_RUNTIME_DIR: root, OPENCODE_CONFIG_DIR: config, OPENCODE_DB: path.join(root, "fixture.db"),
    OPENCODE_SERVER_PASSWORD: randomUUID(), OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_FFF: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "gitconfig-empty"), CHILD_ENV_MARKER: "base" })
  delete process.env.WSL_DISTRO_NAME
  await writeFile(process.env.GIT_CONFIG_GLOBAL, "")
  await writeFile(path.join(config, "opencode.json"), "{}\n")
  execFileSync("git", ["init", project], { windowsHide: true, stdio: "pipe" })
  return { root, config, project }
}
