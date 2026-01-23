import { FastifyInstance } from "fastify"
import { z } from "zod"
import { spawn } from "child_process"
import { FileSystemBrowser } from "../../filesystem/browser"

interface RouteDeps {
  fileSystemBrowser: FileSystemBrowser
}

// Helper to parse boolean query params correctly (string "false" should be false)
const booleanQueryParam = z.union([
  z.boolean(),
  z.string().transform((val) => val === "true" || val === "1"),
]).optional()

const FilesystemQuerySchema = z.object({
  path: z.string().optional(),
  includeFiles: booleanQueryParam,
  /** When true, includes hidden files/folders (starting with .). Defaults to true. */
  includeHidden: booleanQueryParam,
  /** When true, allows navigating the full filesystem regardless of server's restricted mode. */
  allowFullNavigation: booleanQueryParam,
})

const PickFolderBodySchema = z.object({
  title: z.string().optional(),
  defaultPath: z.string().optional(),
})

async function openNativeFolderPicker(options: { title?: string; defaultPath?: string }): Promise<string | null> {
  const platform = process.platform

  return new Promise((resolve) => {
    if (platform === "darwin") {
      // macOS: use osascript with AppleScript
      const defaultLocation = options.defaultPath ? `default location POSIX file "${options.defaultPath}"` : ""
      const prompt = options.title ? `with prompt "${options.title}"` : ""
      const script = `choose folder ${prompt} ${defaultLocation}`

      const proc = spawn("osascript", ["-e", script])
      let stdout = ""
      let stderr = ""

      proc.stdout.on("data", (data) => {
        stdout += data.toString()
      })
      proc.stderr.on("data", (data) => {
        stderr += data.toString()
      })
      proc.on("close", (code) => {
        if (code === 0 && stdout.trim()) {
          // AppleScript returns "alias Macintosh HD:Users:..." format
          // We need to strip "alias " prefix and use proper alias syntax for conversion
          const rawPath = stdout.trim()
          // Extract the HFS path (everything after "alias ")
          const hfsPath = rawPath.startsWith("alias ") ? rawPath.slice(6) : rawPath
          // Escape quotes in the path
          const escapedPath = hfsPath.replace(/"/g, '\\"')
          // Use proper AppleScript alias syntax for POSIX conversion
          const posixProc = spawn("osascript", ["-e", `POSIX path of (alias "${escapedPath}")`])
          let posixPath = ""
          posixProc.stdout.on("data", (data) => {
            posixPath += data.toString()
          })
          posixProc.on("close", (posixCode) => {
            // If POSIX conversion succeeded, use it; otherwise return null
            if (posixCode === 0 && posixPath.trim()) {
              resolve(posixPath.trim())
            } else {
              resolve(null)
            }
          })
        } else {
          resolve(null)
        }
      })
    } else if (platform === "linux") {
      // Linux: try zenity first, then kdialog
      const tryZenity = () => {
        const args = ["--file-selection", "--directory"]
        if (options.title) args.push("--title", options.title)
        const proc = spawn("zenity", args)
        let stdout = ""

        proc.stdout.on("data", (data) => {
          stdout += data.toString()
        })
        proc.on("error", () => {
          tryKdialog()
        })
        proc.on("close", (code) => {
          if (code === 0 && stdout.trim()) {
            resolve(stdout.trim())
          } else {
            resolve(null)
          }
        })
      }

      const tryKdialog = () => {
        const args = ["--getexistingdirectory"]
        if (options.defaultPath) args.push(options.defaultPath)
        if (options.title) args.push("--title", options.title)
        const proc = spawn("kdialog", args)
        let stdout = ""

        proc.stdout.on("data", (data) => {
          stdout += data.toString()
        })
        proc.on("error", () => {
          resolve(null)
        })
        proc.on("close", (code) => {
          if (code === 0 && stdout.trim()) {
            resolve(stdout.trim())
          } else {
            resolve(null)
          }
        })
      }

      tryZenity()
    } else if (platform === "win32") {
      // Windows: use PowerShell
      const script = `
        Add-Type -AssemblyName System.Windows.Forms
        $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
        $dialog.Description = "${options.title || "Select Folder"}"
        ${options.defaultPath ? `$dialog.SelectedPath = "${options.defaultPath}"` : ""}
        if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
          Write-Output $dialog.SelectedPath
        }
      `
      const proc = spawn("powershell", ["-Command", script])
      let stdout = ""

      proc.stdout.on("data", (data) => {
        stdout += data.toString()
      })
      proc.on("close", (code) => {
        if (code === 0 && stdout.trim()) {
          resolve(stdout.trim())
        } else {
          resolve(null)
        }
      })
    } else {
      resolve(null)
    }
  })
}

export function registerFilesystemRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get("/api/filesystem", async (request, reply) => {
    const query = FilesystemQuerySchema.parse(request.query ?? {})

    try {
      return deps.fileSystemBrowser.browse(query.path, {
        includeFiles: query.includeFiles,
        includeHidden: query.includeHidden,
        forceUnrestricted: query.allowFullNavigation,
      })
    } catch (error) {
      reply.code(400)
      return { error: (error as Error).message }
    }
  })

  app.post("/api/filesystem/pick-folder", async (request, reply) => {
    const body = PickFolderBodySchema.parse(request.body ?? {})

    try {
      const selectedPath = await openNativeFolderPicker({
        title: body.title,
        defaultPath: body.defaultPath,
      })

      return { path: selectedPath }
    } catch (error) {
      reply.code(500)
      return { error: (error as Error).message, path: null }
    }
  })

  // Git status endpoint
  const GitStatusQuerySchema = z.object({
    path: z.string(),
  })

  app.get("/api/git/status", async (request, reply) => {
    const query = GitStatusQuerySchema.parse(request.query ?? {})
    const cwd = query.path

    try {
      // Check if it's a git repo
      const isGitRepo = await new Promise<boolean>((resolve) => {
        const proc = spawn("git", ["rev-parse", "--is-inside-work-tree"], { cwd })
        proc.on("close", (code) => resolve(code === 0))
        proc.on("error", () => resolve(false))
      })

      if (!isGitRepo) {
        return { available: false }
      }

      // Get branch name
      const branch = await new Promise<string>((resolve) => {
        const proc = spawn("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd })
        let output = ""
        proc.stdout.on("data", (d) => { output += d.toString() })
        proc.on("close", () => resolve(output.trim() || "unknown"))
        proc.on("error", () => resolve("unknown"))
      })

      // Get ahead/behind counts
      const { ahead, behind } = await new Promise<{ ahead: number; behind: number }>((resolve) => {
        const proc = spawn("git", ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], { cwd })
        let output = ""
        proc.stdout.on("data", (d) => { output += d.toString() })
        proc.on("close", () => {
          const parts = output.trim().split(/\s+/)
          resolve({
            behind: parseInt(parts[0], 10) || 0,
            ahead: parseInt(parts[1], 10) || 0,
          })
        })
        proc.on("error", () => resolve({ ahead: 0, behind: 0 }))
      })

      // Get file status
      const { staged, modified, untracked } = await new Promise<{
        staged: string[]
        modified: string[]
        untracked: string[]
      }>((resolve) => {
        const proc = spawn("git", ["status", "--porcelain", "-uall"], { cwd })
        let output = ""
        proc.stdout.on("data", (d) => { output += d.toString() })
        proc.on("close", () => {
          const staged: string[] = []
          const modified: string[] = []
          const untracked: string[] = []

          for (const line of output.split("\n").filter(Boolean)) {
            const indexStatus = line[0]
            const worktreeStatus = line[1]
            const file = line.slice(3).trim()

            if (indexStatus !== " " && indexStatus !== "?") {
              staged.push(file)
            }
            if (worktreeStatus === "M" || worktreeStatus === "D") {
              modified.push(file)
            }
            if (indexStatus === "?") {
              untracked.push(file)
            }
          }

          resolve({ staged, modified, untracked })
        })
        proc.on("error", () => resolve({ staged: [], modified: [], untracked: [] }))
      })

      return {
        available: true,
        branch,
        ahead,
        behind,
        staged,
        modified,
        untracked,
      }
    } catch (error) {
      reply.code(500)
      return { available: false, error: (error as Error).message }
    }
  })
}
