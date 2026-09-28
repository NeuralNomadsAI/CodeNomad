import { execFile } from "node:child_process"
import path from "node:path"
import { resolveWslHostDirectory } from "../workspaces/spawn"

export interface DesktopPluginNativePath { native: string; host: string }
export type WslPathExecutor = (distro: string, command: string, args: string[], timeoutMs: number) => Promise<string>

function remaining(deadlineAt: number): number {
  const timeout = deadlineAt - Date.now()
  if (timeout <= 0) throw new Error("WSL desktop plugin path resolution timed out")
  return timeout
}

function line(output: string): string {
  const value = output.replace(/\r?\n$/, "")
  if (!value || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid WSL desktop plugin path output")
  return value
}

export function assertNativePluginPath(directory: string): void {
  if (!path.posix.isAbsolute(directory) || directory.startsWith("//") || /[\\\x00-\x1f\x7f]/.test(directory)) {
    throw new Error("Invalid native WSL desktop plugin path")
  }
}

// Resolve existing symlink ancestors, including when the storage tail does not
// exist yet. wslpath knows the distro's mount layout; /mnt/<drive> is not assumed.
export async function resolveDesktopPluginWslPath(
  directory: string,
  distro: string,
  deadlineAt: number,
  assertCurrent: () => void,
  execute: WslPathExecutor = executePath,
): Promise<DesktopPluginNativePath> {
  assertNativePluginPath(directory)
  assertCurrent()
  const native = line(await execute(distro, "realpath", ["-m", "--", directory], remaining(deadlineAt)))
  assertCurrent()
  assertNativePluginPath(native)
  const host = await resolveWslHostDirectory(native, distro, async (folder, selectedDistro, timeout) => {
    const translated = line(await execute(selectedDistro, "wslpath", ["-aw", folder], timeout))
    // Disallow root-relative/drive-relative/device paths and lossy whitespace
    // trimming by the shared conversion utility. UNC mounts remain supported.
    if (translated !== translated.trim() || /[<>"|?*]/.test(translated)
      || !(/^[A-Za-z]:\\/.test(translated) || /^\\\\(?![?.]\\)[^\\:]+\\[^\\]+(?:\\|$)/.test(translated))
      || translated.slice(/^[A-Za-z]:/.test(translated) ? 2 : 0).includes(":")
      || translated.split("\\").some(part => /[ .]$/.test(part))) {
      throw new Error("Invalid Windows desktop plugin path from WSL")
    }
    const wslShare = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)/i.exec(translated)
    if (wslShare && wslShare[1].toLowerCase() !== distro.toLowerCase()) throw new Error("WSL desktop plugin path belongs to another distro")
    return translated
  }, remaining(deadlineAt))
  assertCurrent()
  remaining(deadlineAt)
  if (!host) throw new Error("Cannot translate WSL desktop plugin path for Windows access")
  return { native: path.posix.normalize(native), host: path.win32.normalize(host) }
}

function executePath(distro: string, command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("wsl.exe", ["--distribution", distro, "--exec", command, ...args], {
      encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024,
    }, (error, stdout) => {
      if (error) reject(new Error(`WSL desktop plugin ${command} failed`))
      else resolve(stdout)
    })
  })
}
