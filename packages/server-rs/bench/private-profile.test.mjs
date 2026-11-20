import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import assert from "node:assert/strict"
import { assertPrivateProfile, outsideUserHome } from "./private-profile.mjs"

test("bench profile accepts an owned profile and refuses a missing setting or a junction escape", async () => {
  const scratch = await mkdtemp(path.join(await outsideUserHome(import.meta.dirname), "guard-"))
  try {
    const root = path.join(scratch, "fixture")
    await mkdir(root)
    const names = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "CLI_CONFIG"]
    const env = Object.fromEntries(names.map(name => [name, path.join(root, name)]))
    const location = { baseDir: root, configYamlPath: path.join(root, "config.yaml") }
    await assertPrivateProfile(root, env, location)
    await assert.rejects(assertPrivateProfile(root, { ...env, CLI_CONFIG: undefined }, location))
    await assert.rejects(assertPrivateProfile(root, { ...env, CLI_CONFIG: os.homedir() }, location))
    await assert.rejects(outsideUserHome(os.homedir()))
    await symlink(scratch, env.XDG_STATE_HOME, "junction")
    await assert.rejects(assertPrivateProfile(root, env, location), /escapes/)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})
