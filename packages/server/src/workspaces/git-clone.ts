import fs from "fs"
import path from "path"
import { spawn } from "child_process"
import { homedir } from "os"

class GitCloneError extends Error {
  statusCode: number

  constructor(message: string, statusCode = 400) {
    super(message)
    this.name = "GitCloneError"
    this.statusCode = statusCode
  }
}

function formatErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message
  }
  return fallback
}

function normalizePathForComparison(filePath: string): string {
  const resolvedPath = path.resolve(filePath)
  const rootPath = path.parse(resolvedPath).root
  const trimmedPath = resolvedPath === rootPath ? rootPath : resolvedPath.replace(/[\\/]+$/, "")
  return process.platform === "win32" ? trimmedPath.toLowerCase() : trimmedPath
}

function assertDestinationPathIsSafe(destinationPath: string): void {
  const normalizedDestinationPath = normalizePathForComparison(destinationPath)
  const normalizedRootPath = normalizePathForComparison(path.parse(destinationPath).root)
  if (normalizedDestinationPath === normalizedRootPath) {
    throw new GitCloneError("Destination path cannot be a filesystem root", 400)
  }

  const normalizedHomePath = normalizePathForComparison(homedir())
  if (normalizedDestinationPath === normalizedHomePath) {
    throw new GitCloneError("Destination path cannot be the home folder", 400)
  }
}

function createSiblingUniquePath(destinationPath: string, label: string): string {
  const parentPath = path.dirname(destinationPath)
  const baseName = path.basename(destinationPath)
  return path.join(parentPath, `${baseName}.${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
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

async function replaceDestinationAfterSuccessfulClone(repositoryUrl: string, destinationPath: string): Promise<void> {
  const tempClonePath = createSiblingUniquePath(destinationPath, "clone")
  let backupPath: string | null = null
  let preserveBackup = false

  try {
    await runGitClone(repositoryUrl, tempClonePath)

    backupPath = createSiblingUniquePath(destinationPath, "backup")
    fs.renameSync(destinationPath, backupPath)

    try {
      fs.renameSync(tempClonePath, destinationPath)
    } catch (error) {
      try {
        fs.renameSync(backupPath, destinationPath)
        backupPath = null
      } catch (restoreError) {
        preserveBackup = true
        throw new GitCloneError(
          `Failed to replace clone destination and restore previous contents: ${formatErrorMessage(restoreError, "restore failed")}`,
          500,
        )
      }

      throw new GitCloneError(`Failed to replace clone destination: ${formatErrorMessage(error, "rename failed")}`, 500)
    }

    fs.rmSync(backupPath, { recursive: true, force: true })
    backupPath = null
  } catch (error) {
    if (error instanceof GitCloneError) {
      throw error
    }

    throw new GitCloneError(`Failed to prepare clone destination: ${formatErrorMessage(error, "unknown error")}`, 500)
  } finally {
    if (backupPath && !preserveBackup && fs.existsSync(backupPath)) {
      fs.rmSync(backupPath, { recursive: true, force: true })
    }
    if (fs.existsSync(tempClonePath)) {
      fs.rmSync(tempClonePath, { recursive: true, force: true })
    }
  }
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
  assertDestinationPathIsSafe(destinationPath)
  ensureDestinationParentExists(destinationPath)
  const destinationExists = fs.existsSync(destinationPath)
  assertDestinationIsUsable(destinationPath, Boolean(params.cleanup))

  if (destinationExists && params.cleanup) {
    await replaceDestinationAfterSuccessfulClone(repositoryUrl, destinationPath)
  } else {
    await runGitClone(repositoryUrl, destinationPath)
  }

  return { path: destinationPath }
}
