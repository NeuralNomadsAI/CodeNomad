import fs from "fs"
import path from "path"
import { spawn } from "child_process"

class GitCloneError extends Error {
  statusCode: number

  constructor(message: string, statusCode = 400) {
    super(message)
    this.name = "GitCloneError"
    this.statusCode = statusCode
  }
}

function runGitClone(repositoryUrl: string, destinationPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const parentPath = path.dirname(destinationPath)
    const child = spawn("git", ["clone", "--", repositoryUrl, destinationPath], {
      cwd: parentPath,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stderr = ""
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString()
    })

    child.once("error", (error) => {
      reject(new GitCloneError(error.message || "Failed to start git clone", 500))
    })

    child.once("close", (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new GitCloneError(stderr.trim() || `git clone failed with code ${code}`, 409))
    })
  })
}

function assertDestinationIsUsable(destinationPath: string, cleanup: boolean): void {
  if (!fs.existsSync(destinationPath)) return

  const stat = fs.statSync(destinationPath)
  if (!stat.isDirectory()) {
    throw new GitCloneError("Destination path exists and is not a folder", 409)
  }

  if (cleanup) {
    fs.rmSync(destinationPath, { recursive: true, force: true })
    return
  }

  const entries = fs.readdirSync(destinationPath)
  if (entries.length > 0) {
    throw new GitCloneError("Destination folder is not empty", 409)
  }
}

function ensureDestinationParentExists(destinationPath: string): void {
  const parentPath = path.dirname(destinationPath)
  if (fs.existsSync(parentPath)) return

  fs.mkdirSync(parentPath, { recursive: true })
}

export function isGitCloneError(error: unknown): error is GitCloneError {
  return error instanceof GitCloneError
}

export async function cloneGitRepository(params: {
  repositoryUrl: string
  destinationPath: string
  cleanup?: boolean
}): Promise<{ path: string }> {
  const repositoryUrl = params.repositoryUrl.trim()
  const requestedDestinationPath = params.destinationPath.trim()

  if (!repositoryUrl) {
    throw new GitCloneError("Repository URL is required", 400)
  }
  if (!path.isAbsolute(requestedDestinationPath)) {
    throw new GitCloneError("Destination path must be absolute", 400)
  }

  const destinationPath = path.resolve(requestedDestinationPath)
  ensureDestinationParentExists(destinationPath)
  assertDestinationIsUsable(destinationPath, Boolean(params.cleanup))
  await runGitClone(repositoryUrl, destinationPath)
  return { path: destinationPath }
}
