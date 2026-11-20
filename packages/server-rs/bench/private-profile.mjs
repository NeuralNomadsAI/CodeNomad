// Canonical path fence for the headless comparison bench. Refuse before spawning.
import assert from "node:assert/strict"
import { lstat, readlink, realpath } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const below = (root, file) => {
  const relative = path.relative(root, file)
  return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)
}
// The account's own profile (os.userInfo asks the system), even when HOME/USERPROFILE point elsewhere.
const unsafeRoots = [...new Set([os.homedir(), os.userInfo().homedir])]

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

const within = (root, target) => {
  const relative = path.relative(root, target)
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}

// Resolve even a missing leaf, including dangling links; never create a directory to check it.
async function canonical(file, hops = 0) {
  assert(hops < 64, "Fixture profile path could not be resolved")
  try {
    return await realpath(file)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  const info = await lstat(file).catch(error => { if (error.code !== "ENOENT") throw error })
  if (info?.isSymbolicLink()) return canonical(path.resolve(path.dirname(file), await readlink(file)), hops + 1)
  const parent = path.dirname(file)
  assert.notEqual(parent, file, "Fixture profile path has no existing ancestor")
  return path.join(await canonical(parent, hops + 1), path.basename(file))
}

/** Check the actual home and selected config before spawning either local host. */
export async function assertPrivateHost(env, root, config = env.CLI_CONFIG) {
  const forbidden = await Promise.all(unsafeRoots.map(home => canonical(home)))
  const allowed = value => ![...forbidden, ...unsafeRoots].some(home => within(home, value))
  assert(allowed(root), "Host fixture root is not private")
  const base = await canonical(root)
  const check = async value => {
    assert(typeof value === "string" && path.isAbsolute(value), "Host fixture needs an explicit private profile")
    assert(allowed(value), "Host fixture profile is not private")
    const resolved = await canonical(value)
    assert(within(base, resolved) && allowed(resolved), "Host fixture profile is not private")
    return resolved
  }
  await check(root)
  const home = await check(env.HOME)
  assert.equal(await check(env.USERPROFILE), home, "Host home must match the fixture on both platforms")
  await Promise.all(["APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"].map(key => check(env[key])))
  for (const [key, value] of Object.entries(env)) if (key.toUpperCase().startsWith("XDG_")) await check(value)
  await check(config)
  const folder = /\.(?:json|ya?ml)$/i.test(config) ? path.dirname(config) : config
  await check(folder)
  await check(/\.ya?ml$/i.test(config) ? config : path.join(folder, "config.yaml"))
}

const PROFILE_VARIABLES = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
  "XDG_CACHE_HOME", "npm_config_userconfig", "npm_config_cache", "CLI_CONFIG"]
/** Refuses to start a fixture child whose profile folders or resolved CodeNomad config folder lie
 * under the account's real home: a fixture never reads or writes the user's own profile. */
export function assertOutsideAccount(env, ...configFolders) {
  for (const key of PROFILE_VARIABLES) {
    if (env[key]) assert(!unsafeRoots.some(home => within(home, path.resolve(env[key]))), `Refused: ${key}=${env[key]} is under the user's home`)
  }
  for (const folder of configFolders) assert(!unsafeRoots.some(home => within(home, path.resolve(folder))), `Refused: CodeNomad config ${folder} is under the user's home`)
}
