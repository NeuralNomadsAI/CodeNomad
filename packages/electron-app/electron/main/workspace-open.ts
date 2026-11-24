import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, realpathSync, statSync } from "node:fs"
import { extname, isAbsolute, join, relative, resolve } from "node:path"

export type WorkspaceOpenTarget = "default" | "reveal" | "terminal" | "editor"
export type WorkspaceEditor = "vscode" | "cursor" | "zed" | "vscodium"

interface LaunchCandidate {
  command: string
  args?: string[]
  passPath?: boolean
  waitForExit?: boolean
  verifyStart?: boolean
}

type SpawnProcess = (command: string, args: readonly string[], options: {
  cwd: string
  detached: boolean
  stdio: "ignore"
}) => ChildProcess

interface WorkspaceOpenDependencies {
  openPath: (path: string) => Promise<string>
  revealPath: (path: string) => void
  spawnProcess?: SpawnProcess
}

const BLOCKED_DEFAULT_OPEN_EXTENSIONS = new Set([
  ".appimage", ".application", ".chm", ".com", ".cpl", ".desktop", ".exe", ".jar", ".lnk", ".msi",
  ".msp", ".pif", ".scr", ".url",
])

const SAFE_WINDOWS_OPEN_EXTENSIONS = new Set([
  ".7z", ".avi", ".bmp", ".c", ".cc", ".cfg", ".conf", ".cpp", ".cs", ".css", ".csv", ".dart",
  ".diff", ".docx", ".env", ".flac", ".fs", ".fsx", ".gif", ".go", ".gz", ".h", ".hpp",
  ".htm", ".html", ".ini", ".java", ".jpeg", ".jpg", ".json", ".jsonc", ".jsx", ".kt", ".kts",
  ".less", ".lock", ".log", ".lua", ".md", ".markdown", ".mkv", ".mov", ".mp3", ".mp4", ".ogg",
  ".patch", ".pdf", ".png", ".pptx", ".r", ".rar", ".rmd", ".rs", ".scss", ".sql", ".svg",
  ".svelte", ".swift", ".tar", ".toml", ".ts", ".tsx", ".txt", ".vue", ".wav", ".webm", ".webp",
  ".xlsx", ".xml", ".yaml", ".yml", ".zip",
])

const WINDOWS_EDIT_EXTENSIONS = new Set([
  ".bat", ".cmd", ".js", ".jse", ".pl", ".ps1", ".psd1", ".psm1", ".py", ".pyw", ".rb", ".reg",
  ".vbe", ".vbs", ".wsf", ".wsh",
])

export function defaultOpenMode(path: string, platform: NodeJS.Platform): "open" | "edit" | "choose" {
  const stats = statSync(path)
  const extension = extname(path).toLowerCase()
  if (stats.isDirectory()) {
    if (platform === "darwin" && extension === ".app") throw new Error("Application bundles cannot be opened externally")
    return "open"
  }
  if (platform === "win32") {
    if (SAFE_WINDOWS_OPEN_EXTENSIONS.has(extension)) return "open"
    if (WINDOWS_EDIT_EXTENSIONS.has(extension)) return "edit"
    return "choose"
  }
  if (BLOCKED_DEFAULT_OPEN_EXTENSIONS.has(extension)) {
    throw new Error("Executable files cannot be opened externally")
  }
  if (stats.isFile() && (stats.mode & 0o111) !== 0) {
    throw new Error("Executable files cannot be opened externally")
  }
  return "open"
}

export function editorCandidates(editor: WorkspaceEditor, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): LaunchCandidate[] {
  if (platform === "darwin") {
    const names: Record<WorkspaceEditor, string> = {
      vscode: "Visual Studio Code",
      cursor: "Cursor",
      zed: "Zed",
      vscodium: "VSCodium",
    }
    return [{ command: "/usr/bin/open", args: ["-a", names[editor]], waitForExit: true }]
  }

  if (platform === "win32") {
    const paths: Record<WorkspaceEditor, Array<string | undefined>> = {
      vscode: [
        env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe"),
        env.ProgramFiles && join(env.ProgramFiles, "Microsoft VS Code", "Code.exe"),
      ],
      cursor: [env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "cursor", "Cursor.exe")],
      zed: [env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "Zed", "Zed.exe")],
      vscodium: [
        env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "VSCodium", "VSCodium.exe"),
        env.ProgramFiles && join(env.ProgramFiles, "VSCodium", "VSCodium.exe"),
      ],
    }
    return paths[editor]
      .filter((command): command is string => Boolean(command))
      .filter((command) => !isAbsolute(command) || existsSync(command))
      .map((command) => ({ command }))
  }

  const commands: Record<WorkspaceEditor, string> = { vscode: "code", cursor: "cursor", zed: "zed", vscodium: "codium" }
  return [{ command: commands[editor], verifyStart: true }]
}

export function terminalCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, folder = "."): LaunchCandidate[] {
  if (platform === "darwin") return [{ command: "/usr/bin/open", args: ["-a", "Terminal"], waitForExit: true }]
  if (platform === "win32") {
    const systemRoot = env.SystemRoot?.trim() || "C:\\Windows"
    const command = env.ComSpec?.trim() || join(systemRoot, "System32", "cmd.exe")
    const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    const script = `Set-Location -LiteralPath '${folder.replace(/'/g, "''")}'`
    const encoded = Buffer.from(script, "utf16le").toString("base64")
    return [{
      command,
      args: ["/D", "/C", "start", "", powershell, "-NoExit", "-EncodedCommand", encoded],
      passPath: false,
      waitForExit: true,
    }]
  }

  const configured = env.TERMINAL?.trim()
  return [
    ...(configured ? [{ command: configured, passPath: false, verifyStart: true }] : []),
    ...["xdg-terminal-exec", "x-terminal-emulator", "gnome-terminal", "konsole", "kitty", "alacritty", "wezterm"]
      .map((command) => ({ command, passPath: false, verifyStart: true })),
  ]
}

function launch(candidate: LaunchCandidate, selectedPath: string, cwd: string, spawnProcess: SpawnProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let verificationTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (verificationTimer) clearTimeout(verificationTimer)
      if (error) reject(error)
      else resolve()
    }
    const args = [...(candidate.args ?? []), ...(candidate.passPath === false ? [] : [selectedPath])]
    const child = spawnProcess(candidate.command, args, {
      cwd,
      detached: true,
      stdio: "ignore",
    })
    child.once("spawn", () => {
      if (!candidate.waitForExit) {
        if (candidate.verifyStart) {
          verificationTimer = setTimeout(() => {
            child.unref()
            finish()
          }, 250)
          return
        }
        child.unref()
        finish()
      }
    })
    child.once("exit", (code) => {
      if (!candidate.waitForExit && !candidate.verifyStart) return
      if (code === 0) finish()
      else finish(new Error(`${candidate.command} exited with code ${code ?? "unknown"}`))
    })
    child.once("error", (error) => finish(error))
  })
}

async function launchFirst(candidates: LaunchCandidate[], selectedPath: string, cwd: string, spawnProcess: SpawnProcess): Promise<void> {
  let lastError: unknown
  for (const candidate of candidates) {
    try {
      await launch(candidate, selectedPath, cwd, spawnProcess)
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error("No supported application was found")
}

export async function openWorkspaceTarget(
  target: WorkspaceOpenTarget,
  workspaceFolder: string,
  path = ".",
  editor?: WorkspaceEditor,
  dependencies?: WorkspaceOpenDependencies,
): Promise<void> {
  if (!dependencies) throw new Error("Native workspace openers are unavailable")
  const spawnProcess = dependencies.spawnProcess ?? spawn
  const root = realpathSync(workspaceFolder)
  if (!statSync(root).isDirectory()) throw new Error("Workspace folder does not exist")
  const selectedPath = realpathSync(resolve(root, path))
  const relativePath = relative(root, selectedPath)
  if (relativePath === ".." || relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(relativePath)) {
    throw new Error("Selected path is outside the workspace")
  }
  const cwd = statSync(selectedPath).isDirectory() ? selectedPath : resolve(selectedPath, "..")

  if (target === "default") {
    const mode = defaultOpenMode(selectedPath, process.platform)
    if (mode === "edit" || mode === "choose") {
      const systemRoot = process.env.SystemRoot?.trim() || "C:\\Windows"
      const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      const rundll32 = join(systemRoot, "System32", "rundll32.exe")
      const script = `$ErrorActionPreference='Stop'; Start-Process -FilePath '${selectedPath.replace(/'/g, "''")}' -Verb Edit`
      const encoded = Buffer.from(script, "utf16le").toString("base64")
      const candidates: LaunchCandidate[] = [
        ...(mode === "edit" ? [{
          command: powershell,
          args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
          passPath: false,
          waitForExit: true,
        }] : []),
        {
          command: rundll32,
          args: ["shell32.dll,OpenAs_RunDLL"],
          verifyStart: true,
        },
      ]
      await launchFirst(candidates, selectedPath, cwd, spawnProcess)
      return
    }
    const error = await dependencies.openPath(selectedPath)
    if (error) throw new Error(error)
    return
  }

  if (target === "reveal") {
    dependencies.revealPath(selectedPath)
    return
  }

  if (!statSync(selectedPath).isDirectory() && target === "terminal") throw new Error("Terminal target is not a folder")
  if (target === "editor" && !editor) throw new Error("Editor is required")

  const candidates = target === "terminal"
    ? terminalCandidates(process.platform, process.env, selectedPath)
    : editorCandidates(editor!, process.platform, process.env)
  await launchFirst(candidates, selectedPath, cwd, spawnProcess)
}
