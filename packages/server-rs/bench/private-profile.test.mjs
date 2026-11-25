import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink, unlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { promisify } from "node:util"
import assert from "node:assert/strict"
import { assertPrivateOpenCodeExecutable, assertPrivateProfile, outsideUserHome, ownedOutput } from "./private-profile.mjs"

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

test("bench output permits an internal junction and refuses an external or dangling escape before writing", async () => {
  const scratch = await mkdtemp(path.join(await outsideUserHome(import.meta.dirname), "output-guard-"))
  try {
    const root = path.join(scratch, "checkout"), target = path.join(root, "target")
    await mkdir(target, { recursive: true })
    const link = path.join(root, "out")
    await symlink(target, link, "junction")
    assert.equal(await ownedOutput(root, link), target)
    const escape = path.join(root, "escape"), dangling = path.join(root, "dangling")
    await symlink(scratch, escape, "junction")
    await symlink(path.join(scratch, "absent"), dangling, "junction")
    await assert.rejects(ownedOutput(root, escape), /escapes/)
    await assert.rejects(ownedOutput(root, dangling), /escapes/)
    await assert.rejects(ownedOutput(root, scratch), /belong/)
  } finally { await rm(scratch, { recursive: true, force: true }) }
})

test("compare bench refuses an OpenCode executable inside the user home directly or via junction", async () => {
  const scratch = await mkdtemp(path.join(await outsideUserHome(import.meta.dirname), "exe-guard-"))
  const junction = path.join(scratch, "home-link")
  try {
    const privateBin = path.join(scratch, "bin", "opencode.exe")
    assert.equal(await assertPrivateOpenCodeExecutable(privateBin), privateBin)
    await assert.rejects(assertPrivateOpenCodeExecutable("relative/opencode"), /absolute/)
    await assert.rejects(assertPrivateOpenCodeExecutable(os.homedir()), /outside the user's home/)
    await assert.rejects(assertPrivateOpenCodeExecutable(`${os.homedir()}${path.sep}`), /outside the user's home/)
    const homeBin = path.join(os.homedir(), ".codenomad-test-nonexistent", "opencode.exe")
    await assert.rejects(assertPrivateOpenCodeExecutable(homeBin), /outside the user's home/)
    if (process.platform === "win32") {
      await assert.rejects(assertPrivateOpenCodeExecutable(homeBin.toLowerCase()), /outside the user's home/)
      await assert.rejects(assertPrivateOpenCodeExecutable(String.raw`\\localhost\C$\Users\fixture\opencode.exe`), /drive-qualified local path/)
      await assert.rejects(assertPrivateOpenCodeExecutable(String.raw`\Users\fixture\opencode.exe`), /drive-qualified local path/)
    }
    await symlink(os.homedir(), junction, process.platform === "win32" ? "junction" : "dir")
    await assert.rejects(assertPrivateOpenCodeExecutable(path.join(junction, "opencode.exe")), /resolves inside the user's home/)
    const compare = path.join(import.meta.dirname, "compare.mjs")
    await assert.rejects(
      promisify(execFile)(process.execPath, [compare, "attachment-history", homeBin], { windowsHide: true, timeout: 15_000 }),
      error => error.code !== 0 && /outside the user's home/.test(String(error.stderr)),
    )
  } finally {
    await unlink(junction).catch(() => {})
    await rm(scratch, { recursive: true, force: true })
  }
})
