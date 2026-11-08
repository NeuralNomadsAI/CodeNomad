import { rm } from "node:fs/promises"
import { executeInstaller, openCodeAllowScripts, writeNpmCommands } from "./npm-runtime"
import { createInstallerDirectory, InstallationInterruptedError } from "./installation-lock"

/** Let OpenCode retain its running Windows image while using our npm (in Electron resources,
 * or beside the Node runtime) and the already verified shared prefix, not an unrelated system
 * installation. */
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
  const allowScripts = openCodeAllowScripts(options.version)
  const directory = await createInstallerDirectory(options.prefix, "upgrade")
  let retain = false
  try {
    const env = { ...options.env }
    await writeNpmCommands(directory, options.node, options.npm, env, options.platform)
    // npm config keys are case-insensitive, even on POSIX. Do not allow an
    // inherited prefix or registry to redirect this verified installation, nor
    // an inherited script allow-list to replace the one below.
    for (const key of Object.keys(env)) {
      if (/^npm_config_(prefix|registry|audit|fund|allow_scripts)$/i.test(key)) delete env[key]
    }
    Object.assign(env, {
      npm_config_prefix: options.prefix,
      npm_config_registry: "https://registry.npmjs.org",
      npm_config_audit: "false",
      npm_config_fund: "false",
      // OpenCode runs npm itself: the environment is the only per-invocation channel.
      npm_config_allow_scripts: allowScripts,
    })
    // Windows searches cwd before PATH for npm.cmd. Own that directory too.
    // Give native npm's five-minute deadline time to finish its own cleanup.
    await (options.execute ?? executeInstaller)(options.binary, ["upgrade", options.version, "--method", "npm"], env,
      { cwd: directory, timeout: 360_000 })
  } catch (error) {
    retain = error instanceof InstallationInterruptedError
    throw error
  } finally {
    // A surviving installer may still use this cwd/shim. Preserve it together
    // with the prefix lock after interruption. Cleanup must not mask the error.
    if (!retain) await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}
