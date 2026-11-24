import { execFile } from "node:child_process"
import { mkdir, readFile, appendFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export interface UserPathOptions {
  home?: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  registerWindowsPath?: (bin: string) => Promise<void>
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

async function addProfileLine(file: string, line: string) {
  let existing = ""
  try { existing = await readFile(file, "utf8") } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  if (existing.split(/\r?\n/).includes(line)) return
  await mkdir(path.dirname(file), { recursive: true })
  await appendFile(file, `\n# OpenCode user installation PATH (CodeNomad)\n${line}\n`, { mode: 0o600 })
}

export async function registerWindowsUserPath(bin: string): Promise<void> {
  // Preserve unexpanded %VARIABLE% entries and their registry value type.
  const script = `$ErrorActionPreference = 'Stop'
$bin = '${bin.replaceAll("'", "''")}'
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {
  $raw = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $kind = if ($key.GetValueNames() -contains 'Path') { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
  $found = @($raw -split ';' | Where-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\\') -ieq $bin.TrimEnd('\\') }).Count -gt 0
  if (-not $found) { $key.SetValue('Path', (($raw.TrimEnd(';') + ';' + $bin).TrimStart(';')), $kind) }
} finally { $key.Dispose() }
Add-Type -Namespace CodeNomad -Name EnvironmentBroadcast -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr h, uint m, System.UIntPtr w, string l, uint f, uint t, out System.UIntPtr r);'
$result = [UIntPtr]::Zero
[void][CodeNomad.EnvironmentBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 2000, [ref]$result)
`
  const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  await new Promise<void>((resolve, reject) => execFile(executable,
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 }, error => error ? reject(new Error("Could not register the user terminal PATH")) : resolve()))
}

/** Called only by an explicit installation, never by discovery/status reads. */
export async function registerUserPath(bin: string, options: UserPathOptions = {}): Promise<void> {
  const home = options.home ?? os.homedir()
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const shell = path.basename(env.SHELL || (platform === "darwin" ? "/bin/zsh" : "/bin/bash"))
  if (platform === "win32") {
    await (options.registerWindowsPath ?? registerWindowsUserPath)(bin)
  } else {
    const line = `case ":$PATH:" in *:${quote(bin)}:*) ;; *) export PATH="$PATH":${quote(bin)} ;; esac`
    if (shell === "fish") {
      const config = env.XDG_CONFIG_HOME || path.join(home, ".config")
      // Fish single-quoted strings only interpret escaped quote/backslash.
      const fishBin = `'${bin.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`
      await addProfileLine(path.join(config, "fish", "conf.d", "opencode-path.fish"),
        `if not contains -- ${fishBin} $PATH; set -gx PATH $PATH ${fishBin}; end`)
    } else if (shell === "zsh") {
      for (const name of [".zprofile", ".zshrc"]) await addProfileLine(path.join(env.ZDOTDIR || home, name), line)
    } else if (shell === "bash" || shell === "sh") {
      await addProfileLine(path.join(home, ".profile"), line)
      if (shell === "bash") {
        await addProfileLine(path.join(home, ".bashrc"), line)
        for (const name of [".bash_profile", ".bash_login"]) {
          try { await readFile(path.join(home, name)); await addProfileLine(path.join(home, name), line) }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
        }
      }
    } else throw new Error("Register the OpenCode installation directory in this shell's PATH manually")
  }
  const key = Object.keys(env).find(key => key.toLowerCase() === "path") ?? "PATH"
  const delimiter = platform === "win32" ? ";" : ":"
  const normalize = (value: string) => platform === "win32" ? value.toLowerCase().replace(/[\\/]+$/, "") : value
  if (!(env[key] || "").split(delimiter).some(value => normalize(value) === normalize(bin))) {
    env[key] = [env[key], bin].filter(Boolean).join(delimiter)
  }
}
