import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import type { ServiceLaunchSpec } from "../workspaces/spawn"
import { installPruningPresence, type PruningPaths } from "./pruning-installation"

const execute = promisify(execFile)

function hostPaths(env: NodeJS.ProcessEnv): PruningPaths {
  const home = os.homedir()
  return {
    config: env.OPENCODE_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode"),
    data: path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "codenomad"),
  }
}

async function wslPaths(distro: string, env: NodeJS.ProcessEnv): Promise<PruningPaths> {
  const keys = ["OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]
  const { stdout } = await execute("wsl.exe", ["--distribution", distro, "--exec", "env",
    ...keys.filter(key => env[key] !== undefined).map(key => `${key}=${env[key]}`),
    "sh", "-c", 'printf "%s\\n%s\\n" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}" "${XDG_DATA_HOME:-$HOME/.local/share}/codenomad"',
  ], { windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 })
  const [config, data] = stdout.trim().split(/\r?\n/)
  if (!config?.startsWith("/") || !data?.startsWith("/")) throw new Error("Could not resolve WSL plugin directories")
  const unc = (directory: string) => `\\\\wsl.localhost\\${distro}${directory.replaceAll("/", "\\")}`
  return { config: unc(config), data: unc(data), nativeData: data }
}

// One backend owns one lease per daemon namespace, shared by all its windows.
// Other profiles/backends own independent leases; none owns or stops OpenCode.
export class PruningLifecycle {
  private readonly installations = new Map<string, Promise<() => Promise<void>>>()
  private stopped = false

  async start(launch?: ServiceLaunchSpec, environment: NodeJS.ProcessEnv = {}): Promise<void> {
    if (this.stopped) return
    const paths = launch?.kind === "wsl" ? await wslPaths(launch.distro, environment) : hostPaths({ ...process.env, ...environment })
    if (this.stopped) return
    const key = paths.config
    if (!this.installations.has(key)) {
      const installation = (async () => {
        const bundle = await readFile(new URL("../plugins/session-pruning/plugin.mjs", import.meta.url))
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error
            return readFile(new URL("../../dist/plugins/session-pruning/plugin.mjs", import.meta.url))
          })
        return installPruningPresence(bundle, paths)
      })()
      this.installations.set(key, installation)
      void installation.catch(() => { if (this.installations.get(key) === installation) this.installations.delete(key) })
    }
    await this.installations.get(key)
  }

  async stop(): Promise<void> {
    this.stopped = true
    await Promise.all([...this.installations.values()].map(async installation => {
      const dispose = await installation.catch(() => undefined)
      await dispose?.()
    }))
    this.installations.clear()
  }
}
