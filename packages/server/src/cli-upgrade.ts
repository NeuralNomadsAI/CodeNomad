import { spawn } from "child_process"

const CODENOMAD_PACKAGE_NAME = "@neuralnomads/codenomad"

export type SupportedPackageManager = "npm" | "pnpm" | "bun"

export interface UpgradeCommand {
  command: SupportedPackageManager
  args: string[]
  packageSpec: string
}

function detectFromText(value: string | undefined): SupportedPackageManager | null {
  const lower = (value ?? "").toLowerCase()
  if (!lower) return null
  if (lower.includes("pnpm")) return "pnpm"
  if (lower.includes("bun")) return "bun"
  if (lower.includes("npm")) return "npm"
  return null
}

export function detectPackageManager(env: NodeJS.ProcessEnv = process.env): SupportedPackageManager {
  return detectFromText(env.npm_config_user_agent) ?? detectFromText(env.npm_execpath) ?? "npm"
}

export function buildUpgradeCommand(
  version?: string,
  packageManager: SupportedPackageManager = detectPackageManager(),
): UpgradeCommand {
  const targetVersion = (version ?? "").trim() || "latest"
  const packageSpec = `${CODENOMAD_PACKAGE_NAME}@${targetVersion}`

  return {
    command: packageManager,
    args: ["install", "-g", packageSpec],
    packageSpec,
  }
}

export function formatUpgradeCommand(command: UpgradeCommand): string {
  return [command.command, ...command.args].join(" ")
}

export function runCliUpgrade(version?: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const upgrade = buildUpgradeCommand(version, detectPackageManager(env))
  console.log(`Upgrading CodeNomad with: ${formatUpgradeCommand(upgrade)}`)

  return new Promise((resolve) => {
    const child = spawn(upgrade.command, upgrade.args, {
      env,
      shell: process.platform === "win32",
      stdio: "inherit",
    })

    child.on("exit", (code, signal) => {
      if (signal) {
        console.error(`Upgrade command stopped by signal ${signal}`)
        resolve(1)
        return
      }
      resolve(code ?? 0)
    })

    child.on("error", (error) => {
      console.error("Failed to launch upgrade command", error)
      resolve(1)
    })
  })
}
