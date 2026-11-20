// Canonical path fence for the headless comparison bench. Refuse before spawning.
import assert from "node:assert/strict"
import { lstat, realpath } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const below = (root, file) => {
  const relative = path.relative(root, file)
  return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)
}
const unsafeRoots = [os.homedir(), ...(process.platform === "win32" ? ["C:\\Users\\Admin"] : [])]

export async function outsideUserHome(directory) {
  const resolved = await realpath(directory)
  assert(!unsafeRoots.some(home => below(home, directory) || below(home, resolved)), "Bench profile must be outside the user's home")
  return resolved
}

export async function assertPrivateProfile(root, env, location) {
  const owned = await outsideUserHome(root)
  async function check(file) {
    assert(typeof file === "string" && path.isAbsolute(file) && below(root, file), "Expected an absolute bench profile path")
    for (let candidate = file;; candidate = path.dirname(candidate)) {
      const present = await lstat(candidate).catch(error => {
        if (error.code !== "ENOENT") throw error
      })
      if (!present) continue
      const canonical = await realpath(candidate) // A dangling link is an error.
      assert(below(owned, canonical), "Bench profile escapes its private fixture")
      return
    }
  }
  for (const name of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "CLI_CONFIG"]) {
    await check(env[name])
  }
  for (const file of Object.values(location)) await check(file)
}
