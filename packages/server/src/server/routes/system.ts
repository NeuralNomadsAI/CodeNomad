import { FastifyInstance } from "fastify"
import { spawn, exec } from "child_process"
import os from "os"
import { promisify } from "util"
import {
  cleanupOrphanedWorkspaces,
  scanForUnregisteredOrphans,
  getAllRunningProcesses,
  getRegisteredWorkspaces,
  type WorkspacePidEntry,
} from "../../workspaces/pid-registry"

const execAsync = promisify(exec)

interface RouteDeps {
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void
    error: (msg: string, meta?: Record<string, unknown>) => void
    debug: (msg: string, meta?: Record<string, unknown>) => void
  }
}

// Allowed commands for security - only these can be executed
const ALLOWED_COMMANDS = new Set([
  "gcloud",
  "gh",
  "which",
  "where", // Windows equivalent of which
  "brew",
  "winget",
  "apt-get",
  "apt",
  "snap",
  "dnf",
  "yum",
])

// Allowed subcommands per command for additional security
const ALLOWED_SUBCOMMANDS: Record<string, Set<string>> = {
  gcloud: new Set(["auth", "config", "--version", "projects"]),
  gh: new Set(["auth", "--version", "api", "repo"]),
  which: new Set(["gcloud", "gh", "brew", "winget", "apt-get", "snap", "dnf", "yum"]),
  where: new Set(["gcloud", "gh", "winget"]),
  brew: new Set(["install", "--version"]),
  winget: new Set(["install", "--version"]),
  "apt-get": new Set(["install", "update"]),
  apt: new Set(["install", "update"]),
  snap: new Set(["install"]),
  dnf: new Set(["install"]),
  yum: new Set(["install"]),
}

export interface CliToolStatus {
  name: string
  installed: boolean
  version: string | null
  path: string | null
}

export interface SystemInfo {
  platform: NodeJS.Platform
  arch: string
  packageManager: string | null
  cliTools: CliToolStatus[]
}

export function registerSystemRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { logger } = deps

  // Get system info and CLI tool status
  app.get("/api/system/info", async () => {
    const platform = os.platform()
    const arch = os.arch()

    // Detect package manager
    const packageManager = await detectPackageManager(platform)

    // Check CLI tools
    const cliTools = await Promise.all([
      checkCliTool("gh", ["--version"]),
      checkCliTool("gcloud", ["--version"]),
    ])

    return {
      platform,
      arch,
      packageManager,
      cliTools,
    } satisfies SystemInfo
  })

  // Check specific CLI tool status
  app.get<{ Params: { tool: string } }>("/api/system/cli/:tool", async (request, reply) => {
    const { tool } = request.params

    if (!["gh", "gcloud"].includes(tool)) {
      return reply.status(400).send({ error: "Invalid tool name" })
    }

    const status = await checkCliTool(tool, ["--version"])
    return status
  })

  // Install CLI tool
  app.post<{ Body: { tool: string } }>("/api/system/cli/install", async (request, reply) => {
    const { tool } = request.body

    if (!["gh", "gcloud"].includes(tool)) {
      return reply.status(400).send({ error: "Invalid tool name" })
    }

    const platform = os.platform()
    const packageManager = await detectPackageManager(platform)

    if (!packageManager) {
      return reply.status(400).send({
        error: "No package manager detected",
        instructions: getManualInstallInstructions(tool, platform),
      })
    }

    try {
      const result = await installCliTool(tool, platform, packageManager, logger)
      return result
    } catch (error) {
      logger.error("Failed to install CLI tool", { tool, error })
      return reply.status(500).send({
        error: error instanceof Error ? error.message : "Installation failed",
        instructions: getManualInstallInstructions(tool, platform),
      })
    }
  })

  // Execute allowed CLI commands
  app.post<{
    Body: {
      command: string
      args: string[]
      background?: boolean
      timeout?: number
    }
  }>("/api/system/exec", async (request, reply) => {
    const { command, args = [], background = false, timeout = 30000 } = request.body

    // Security check: validate command
    if (!ALLOWED_COMMANDS.has(command)) {
      logger.error("Blocked disallowed command", { command })
      return reply.status(403).send({ error: `Command '${command}' is not allowed` })
    }

    // Security check: validate subcommand
    const subcommand = args[0]
    const allowedSubs = ALLOWED_SUBCOMMANDS[command]
    if (allowedSubs && subcommand && !allowedSubs.has(subcommand)) {
      logger.error("Blocked disallowed subcommand", { command, subcommand })
      return reply.status(403).send({ error: `Subcommand '${subcommand}' is not allowed for '${command}'` })
    }

    logger.debug("Executing command", { command, args, background })

    try {
      if (background) {
        // For background commands, spawn and return immediately
        const result = await executeCommandBackground(command, args, timeout)
        return result
      } else {
        // For foreground commands, wait for completion
        const result = await executeCommand(command, args, timeout)
        return result
      }
    } catch (error) {
      logger.error("Command execution failed", { command, args, error })
      return reply.status(500).send({
        error: error instanceof Error ? error.message : "Execution failed",
        stdout: "",
        stderr: error instanceof Error ? error.message : "",
        exitCode: 1,
      })
    }
  })
}

async function checkCliTool(name: string, versionArgs: string[]): Promise<CliToolStatus> {
  try {
    // Check if installed using 'which' (Unix) or 'where' (Windows)
    const whichCmd = os.platform() === "win32" ? "where" : "which"
    const { stdout: pathOutput } = await execAsync(`${whichCmd} ${name}`)
    const toolPath = pathOutput.trim().split("\n")[0]

    // Get version
    const { stdout: versionOutput } = await execAsync(`${name} ${versionArgs.join(" ")}`)
    const version = parseVersion(name, versionOutput)

    return {
      name,
      installed: true,
      version,
      path: toolPath,
    }
  } catch {
    return {
      name,
      installed: false,
      version: null,
      path: null,
    }
  }
}

function parseVersion(tool: string, output: string): string | null {
  const lines = output.trim().split("\n")

  if (tool === "gh") {
    // gh version 2.83.0 (2025-11-04)
    const match = lines[0]?.match(/gh version ([\d.]+)/)
    return match?.[1] ?? lines[0] ?? null
  }

  if (tool === "gcloud") {
    // Google Cloud SDK 548.0.0
    const match = lines[0]?.match(/Google Cloud SDK ([\d.]+)/)
    return match?.[1] ?? lines[0] ?? null
  }

  return lines[0] ?? null
}

async function detectPackageManager(platform: NodeJS.Platform): Promise<string | null> {
  const whichCmd = platform === "win32" ? "where" : "which"

  if (platform === "darwin") {
    try {
      await execAsync(`${whichCmd} brew`)
      return "brew"
    } catch {
      return null
    }
  }

  if (platform === "win32") {
    try {
      await execAsync("winget --version")
      return "winget"
    } catch {
      return null
    }
  }

  if (platform === "linux") {
    // Try various package managers
    const managers = ["apt-get", "dnf", "yum", "snap"]
    for (const mgr of managers) {
      try {
        await execAsync(`${whichCmd} ${mgr}`)
        return mgr
      } catch {
        continue
      }
    }
  }

  return null
}

async function installCliTool(
  tool: string,
  platform: NodeJS.Platform,
  packageManager: string,
  logger: RouteDeps["logger"]
): Promise<{ success: boolean; message: string }> {
  const installCommands = getInstallCommand(tool, platform, packageManager)

  if (!installCommands) {
    throw new Error(`No install command for ${tool} on ${platform} with ${packageManager}`)
  }

  logger.info("Installing CLI tool", { tool, platform, packageManager, commands: installCommands })

  for (const cmd of installCommands) {
    const { stdout, stderr } = await execAsync(cmd, { timeout: 300000 }) // 5 min timeout
    logger.debug("Install command output", { cmd, stdout, stderr })
  }

  // Verify installation
  const status = await checkCliTool(tool, ["--version"])
  if (status.installed) {
    return { success: true, message: `${tool} ${status.version} installed successfully` }
  } else {
    throw new Error(`Installation completed but ${tool} not found in PATH`)
  }
}

function getInstallCommand(tool: string, platform: NodeJS.Platform, packageManager: string): string[] | null {
  if (tool === "gh") {
    if (platform === "darwin" && packageManager === "brew") {
      return ["brew install gh"]
    }
    if (platform === "win32" && packageManager === "winget") {
      return ["winget install --id GitHub.cli"]
    }
    if (platform === "linux") {
      if (packageManager === "apt-get") {
        return [
          "sudo mkdir -p -m 755 /etc/apt/keyrings",
          "wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null",
          "sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg",
          'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null',
          "sudo apt-get update",
          "sudo apt-get install gh -y",
        ]
      }
      if (packageManager === "dnf" || packageManager === "yum") {
        return [
          "sudo dnf install 'dnf-command(config-manager)' -y",
          "sudo dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo",
          "sudo dnf install gh -y",
        ]
      }
      if (packageManager === "snap") {
        return ["sudo snap install gh"]
      }
    }
  }

  if (tool === "gcloud") {
    if (platform === "darwin" && packageManager === "brew") {
      return ["brew install --cask google-cloud-sdk"]
    }
    if (platform === "win32" && packageManager === "winget") {
      return ["winget install --id Google.CloudSDK"]
    }
    if (platform === "linux") {
      if (packageManager === "apt-get") {
        return [
          "sudo apt-get update",
          "sudo apt-get install apt-transport-https ca-certificates gnupg curl -y",
          'echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | sudo tee -a /etc/apt/sources.list.d/google-cloud-sdk.list',
          "curl https://packages.cloud.google.com/apt/doc/apt-key.gpg | sudo apt-key --keyring /usr/share/keyrings/cloud.google.gpg add -",
          "sudo apt-get update",
          "sudo apt-get install google-cloud-cli -y",
        ]
      }
      if (packageManager === "snap") {
        return ["sudo snap install google-cloud-cli --classic"]
      }
    }
  }

  return null
}

function getManualInstallInstructions(tool: string, platform: NodeJS.Platform): string {
  if (tool === "gh") {
    return `Install GitHub CLI manually:
- macOS: brew install gh
- Windows: winget install --id GitHub.cli
- Linux: https://github.com/cli/cli/blob/trunk/docs/install_linux.md
- Or download from: https://cli.github.com/`
  }

  if (tool === "gcloud") {
    return `Install Google Cloud SDK manually:
- macOS: brew install --cask google-cloud-sdk
- Windows: winget install --id Google.CloudSDK
- Linux: https://cloud.google.com/sdk/docs/install
- Or download from: https://cloud.google.com/sdk/docs/install`
  }

  return `Visit the official website to install ${tool}`
}

async function executeCommand(
  command: string,
  args: string[],
  timeout: number
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      shell: true,
      timeout,
    })

    let stdout = ""
    let stderr = ""

    proc.stdout?.on("data", (data) => {
      stdout += data.toString()
    })

    proc.stderr?.on("data", (data) => {
      stderr += data.toString()
    })

    proc.on("close", (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 0,
      })
    })

    proc.on("error", (error) => {
      reject(error)
    })
  })
}

async function executeCommandBackground(
  command: string,
  args: string[],
  timeout: number
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // For background commands, we still need to capture some output
  // but we return faster with partial results
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      shell: true,
      detached: false,
    })

    let stdout = ""
    let stderr = ""
    let resolved = false

    const resolveOnce = (exitCode: number) => {
      if (!resolved) {
        resolved = true
        resolve({ stdout, stderr, exitCode })
      }
    }

    proc.stdout?.on("data", (data) => {
      stdout += data.toString()
    })

    proc.stderr?.on("data", (data) => {
      stderr += data.toString()
    })

    proc.on("close", (code) => {
      resolveOnce(code ?? 0)
    })

    proc.on("error", (error) => {
      if (!resolved) {
        resolved = true
        reject(error)
      }
    })

    // For background commands like gcloud auth, resolve after getting initial output
    setTimeout(() => {
      resolveOnce(0)
    }, Math.min(timeout, 5000))
  })
}

// ============================================================================
// Process Management API Routes
// ============================================================================

export interface ProcessInfo {
  registered: Array<{
    workspaceId: string
    entry: WorkspacePidEntry
    running: boolean
  }>
  unregistered: number[]
  summary: {
    totalRegistered: number
    runningRegistered: number
    unregisteredOrphans: number
  }
}

export interface CleanupResult {
  registeredCleanup: {
    cleaned: number
    failed: number
    failedPids: number[]
  }
  unregisteredCleanup: {
    found: number
    killed: number
    pids: number[]
  }
}

export function registerProcessManagementRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { logger } = deps

  /**
   * Get all running processes (registered and unregistered)
   */
  app.get("/api/system/processes", async (): Promise<ProcessInfo> => {
    const { registered, unregistered } = getAllRunningProcesses()

    return {
      registered,
      unregistered,
      summary: {
        totalRegistered: registered.length,
        runningRegistered: registered.filter((r) => r.running).length,
        unregisteredOrphans: unregistered.length,
      },
    }
  })

  /**
   * Get only the PID registry (without scanning for unregistered)
   */
  app.get("/api/system/processes/registry", async () => {
    return getRegisteredWorkspaces()
  })

  /**
   * Clean up all orphaned processes
   */
  app.post("/api/system/processes/cleanup", async (): Promise<CleanupResult> => {
    logger.info("Manual orphan cleanup triggered via API")

    // Clean registered orphans (logger parameter is optional)
    const registeredCleanup = await cleanupOrphanedWorkspaces()

    // Clean unregistered orphans (logger parameter is optional)
    const unregisteredCleanup = await scanForUnregisteredOrphans()

    return {
      registeredCleanup,
      unregisteredCleanup,
    }
  })

  /**
   * Kill a specific process by PID
   */
  app.delete<{ Params: { pid: string } }>("/api/system/processes/:pid", async (request, reply) => {
    const pid = parseInt(request.params.pid, 10)

    if (isNaN(pid) || pid <= 0) {
      return reply.status(400).send({ error: "Invalid PID" })
    }

    logger.info("Killing process via API", { pid })

    try {
      // Check if process exists
      try {
        process.kill(pid, 0)
      } catch {
        return reply.status(404).send({ error: `Process ${pid} not found or already dead` })
      }

      // Send SIGTERM
      process.kill(pid, "SIGTERM")

      // Wait briefly
      await new Promise((resolve) => setTimeout(resolve, 1000))

      // Check if still running
      let stillRunning = false
      try {
        process.kill(pid, 0)
        stillRunning = true
      } catch {
        stillRunning = false
      }

      if (stillRunning) {
        // Force kill
        process.kill(pid, "SIGKILL")
        await new Promise((resolve) => setTimeout(resolve, 500))

        // Final check
        try {
          process.kill(pid, 0)
          return reply.status(500).send({
            error: `Process ${pid} survived SIGKILL`,
            killed: false,
          })
        } catch {
          // Successfully killed
        }
      }

      return { killed: true, pid }
    } catch (error) {
      logger.error("Failed to kill process", { pid, error })
      return reply.status(500).send({
        error: error instanceof Error ? error.message : "Failed to kill process",
        killed: false,
      })
    }
  })

  /**
   * Kill all orphaned processes (both registered and unregistered)
   */
  app.post("/api/system/processes/kill-all-orphans", async (): Promise<CleanupResult> => {
    logger.info("Kill all orphans triggered via API")

    // Clean registered orphans (logger parameter is optional)
    const registeredCleanup = await cleanupOrphanedWorkspaces()

    // Clean unregistered orphans (logger parameter is optional)
    const unregisteredCleanup = await scanForUnregisteredOrphans()

    return {
      registeredCleanup,
      unregisteredCleanup,
    }
  })
}
