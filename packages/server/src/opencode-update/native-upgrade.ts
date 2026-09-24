import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { executeInstaller } from "./npm-runtime"

/** Let OpenCode retain its running Windows image while using our bundled npm
 * and the already verified shared prefix, not an unrelated system installation. */
export async function upgradeSharedOpenCode(options: {
  binary: string
  version: string
  prefix: string
  node: string
  npm: string
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  execute?: typeof executeInstaller
}): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-upgrade-"))
  try {
    const windows = options.platform === "win32"
    const shim = windows
      ? '@echo off\r\n"%CODENOMAD_UPGRADE_NODE%" "%CODENOMAD_UPGRADE_NPM%" %*\r\n'
      : '#!/bin/sh\nexec "$CODENOMAD_UPGRADE_NODE" "$CODENOMAD_UPGRADE_NPM" "$@"\n'
    await writeFile(path.join(directory, windows ? "npm.cmd" : "npm"), shim, { mode: 0o700 })
    const env = { ...options.env }
    // npm config keys are case-insensitive, even on POSIX. Do not allow an
    // inherited prefix or registry to redirect this verified installation.
    for (const key of Object.keys(env)) {
      if (/^npm_config_(prefix|registry|audit|fund)$/i.test(key)) delete env[key]
    }
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === "path") ?? "PATH"
    env[pathKey] = [directory, path.dirname(options.node), env[pathKey] || ""].join(windows ? ";" : ":")
    Object.assign(env, {
      CODENOMAD_UPGRADE_NODE: options.node,
      CODENOMAD_UPGRADE_NPM: options.npm,
      npm_config_prefix: options.prefix,
      npm_config_registry: "https://registry.npmjs.org",
      npm_config_audit: "false",
      npm_config_fund: "false",
    })
    // Windows searches cwd before PATH for npm.cmd. Own that directory too.
    await (options.execute ?? executeInstaller)(options.binary, ["upgrade", options.version, "--method", "npm"], env, directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
