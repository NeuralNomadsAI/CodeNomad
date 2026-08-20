import { realpath } from "node:fs/promises"
import path from "node:path"

export async function resolveWorkspacePath(folder: string, rootDir: string): Promise<string> {
  const submittedPath = path.isAbsolute(folder) ? path.normalize(folder) : path.resolve(rootDir, folder)
  try {
    return path.normalize(await realpath(submittedPath))
  } catch {
    return submittedPath
  }
}
