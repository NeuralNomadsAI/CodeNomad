import { spawn, spawnSync } from "child_process"
import path from "path"

interface ShellCommand {
  command: string
  args: string[]
}

const isWindows = process.platform === "win32"

function getDefaultShellPath(): string {
  if (process.env.SHELL && process.env.SHELL.trim().length > 0) {
    return process.env.SHELL
  }

  if (process.platform === "darwin") {
    return "/bin/zsh"
  }

  return "/bin/bash"
}

function wrapCommandForShell(command: string, shellPath: string): string {
  const shellName = path.basename(shellPath)

  if (shellName.includes("bash")) {
    return 'if [ -f ~/.bashrc ]; then source ~/.bashrc >/dev/null 2>&1; fi; ' + command
  }

  if (shellName.includes("zsh")) {
    return 'if [ -f ~/.zshrc ]; then source ~/.zshrc >/dev/null 2>&1; fi; ' + command
  }

  return command
}

function buildShellArgs(shellPath: string): string[] {
  const shellName = path.basename(shellPath)
  if (shellName.includes("zsh")) {
    return ["-l", "-i", "-c"]
  }
  return ["-l", "-c"]
}

function sanitizeShellEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cleaned = { ...env }
  delete cleaned.npm_config_prefix
  delete cleaned.NPM_CONFIG_PREFIX
  return cleaned
}

export function supportsUserShell(): boolean {
  return !isWindows
}

export function buildUserShellCommand(userCommand: string): ShellCommand {
  if (!supportsUserShell()) {
    throw new Error("User shell invocation is only supported on POSIX platforms")
  }

  const shellPath = getDefaultShellPath()
  const script = wrapCommandForShell(userCommand, shellPath)
  const args = buildShellArgs(shellPath)

  return {
    command: shellPath,
    args: [...args, script],
  }
}

export function getUserShellEnv(): NodeJS.ProcessEnv {
  if (!supportsUserShell()) {
    throw new Error("User shell invocation is only supported on POSIX platforms")
  }
  return sanitizeShellEnv(process.env)
}

export function runUserShellCommand(userCommand: string, timeoutMs = 5000): Promise<string> {
  if (!supportsUserShell()) {
    return Promise.reject(new Error("User shell invocation is only supported on POSIX platforms"))
  }

  const { command, args } = buildUserShellCommand(userCommand)
  const env = getUserShellEnv()

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    })

    let stdout = ""
    let stderr = ""

    const timeout = setTimeout(() => {
      child.kill("SIGTERM")
      reject(new Error(`Shell command timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout?.on("data", (data) => {
      stdout += data.toString()
    })

    child.stderr?.on("data", (data) => {
      stderr += data.toString()
    })

    child.on("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })

    child.on("close", (code) => {
      clearTimeout(timeout)
      if (code === 0) {
        resolve(stdout.trim())
      } else {
        reject(new Error(stderr.trim() || `Shell command exited with code ${code}`))
      }
    })
  })
}

export function runUserShellCommandSync(userCommand: string): string {
  if (!supportsUserShell()) {
    throw new Error("User shell invocation is only supported on POSIX platforms")
  }

  const { command, args } = buildUserShellCommand(userCommand)
  const env = getUserShellEnv()
  const result = spawnSync(command, args, { encoding: "utf-8", env })

  if (result.status !== 0) {
    const stderr = (result.stderr || "").toString().trim()
    throw new Error(stderr || "Shell command failed")
  }

  return (result.stdout || "").toString().trim()
}
