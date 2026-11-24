import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execute = promisify(execFile)
const PRIVATE_VARIABLES = new Set([
  "OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD", "CODENOMAD_SERVER_PASSWORD",
  "CODENOMAD_AUTOMATION_BRIDGE_TOKEN", "CODENOMAD_BOOTSTRAP_TOKEN",
])
const STORAGE_VARIABLES = new Set(["OPENCODE_DB", "XDG_STATE_HOME"])

// session.environment replaces the whole snapshot, not just the configured keys.
// Build it on the execution host; a WSL shell must never receive Windows PATH/HOME.
export async function sessionEnvironment(
  configured: unknown,
  options: {
    distro?: string
    platform?: NodeJS.Platform
    environment?: NodeJS.ProcessEnv
    signal?: AbortSignal
    readWsl?: typeof readWslEnvironment
  } = {},
): Promise<Record<string, string>> {
  if (configured !== undefined && (!configured || typeof configured !== "object" || Array.isArray(configured))) {
    throw new Error("Invalid session environment")
  }
  const base = options.distro
    ? await (options.readWsl ?? readWslEnvironment)(options.distro, options.signal)
    : options.environment ?? process.env
  const windows = !options.distro && (options.platform ?? process.platform) === "win32"
  const values = new Map<string, [string, string]>()
  for (const [source, overrides] of [[base, false], [configured ?? {}, true]] as const) {
    for (const [key, value] of Object.entries(source)) {
      const upper = key.toUpperCase()
      if (value === undefined || PRIVATE_VARIABLES.has(upper) || STORAGE_VARIABLES.has(upper)) continue
      if (typeof value !== "string" || !key || key.includes("=") || key.includes("\0") || value.includes("\0")) {
        if (overrides) throw new Error("Invalid session environment variable")
        continue
      }
      values.set(windows ? upper : key, [key, value])
    }
  }
  return Object.fromEntries(values.values())
}

async function readWslEnvironment(distro: string, signal?: AbortSignal): Promise<NodeJS.ProcessEnv> {
  const { stdout } = await execute("wsl.exe", ["--distribution", distro, "--exec", "env", "-0"], {
    encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024, signal,
  })
  const entries = stdout.split("\0").filter(Boolean).map(entry => {
    const separator = entry.indexOf("=")
    if (separator < 1) throw new Error("Invalid WSL environment")
    return [entry.slice(0, separator), entry.slice(separator + 1)]
  })
  if (!entries.length) throw new Error("Empty WSL environment")
  return Object.fromEntries(entries)
}
