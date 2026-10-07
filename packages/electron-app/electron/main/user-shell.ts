import path from "path"

interface ShellCommand {
  command: string
  args: string[]
}

const isWindows = process.platform === "win32"

export function getDefaultShellPath(
  platform: NodeJS.Platform = process.platform,
  configuredShell = process.env.SHELL,
): string {
  const shellPath = configuredShell?.trim()
  if (shellPath && isSupportedPosixShell(shellPath)) {
    return shellPath
  }

  // The launch script uses POSIX syntax. Never pass it to arbitrary user shells
  // such as Nushell or Fish even when they are configured through $SHELL.
  if (platform === "darwin") {
    return "/bin/zsh"
  }

  return "/bin/bash"
}

function isSupportedPosixShell(shellPath: string): boolean {
  const shellName = path.basename(shellPath).toLowerCase()
  return shellName === "bash" || shellName === "zsh"
}

function buildShellArgs(shellPath: string): string[] {
  const shellName = path.basename(shellPath)
  if (shellName.includes("zsh") || shellName.includes("bash")) {
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
  const args = buildShellArgs(shellPath)
  // Unlike zsh, login bash does not automatically read .bashrc. Preserve the
  // previous Bash compatibility path even when a profile doesn't source it.
  const script = path.basename(shellPath).toLowerCase() === "bash"
    ? 'if [ -f ~/.bashrc ]; then source ~/.bashrc >/dev/null 2>&1; fi; ' + userCommand
    : userCommand

  return {
    command: shellPath,
    // Zsh already loads .zshrc: never explicitly source it a second time.
    args: [...args, script],
  }
}

export function getUserShellEnv(): NodeJS.ProcessEnv {
  if (!supportsUserShell()) {
    throw new Error("User shell invocation is only supported on POSIX platforms")
  }
  return sanitizeShellEnv(process.env)
}
