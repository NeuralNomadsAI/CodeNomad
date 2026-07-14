import { realpath, stat } from "node:fs/promises"
import path from "node:path"

export function normalizeWorkspaceIdentityPath(value: string, platform: NodeJS.Platform = process.platform): string {
  const pathApi = platform === "win32" ? path.win32 : path.posix
  const normalized = pathApi.normalize(value)
  return platform === "win32" ? normalized.toLowerCase() : normalized
}

export async function resolveWorkspaceIdentity(
  folder: string,
  rootDir: string,
): Promise<{ workspacePath: string; identityKey: string }> {
  const submittedPath = path.isAbsolute(folder) ? path.normalize(folder) : path.resolve(rootDir, folder)

  try {
    const workspacePath = path.normalize(await realpath(submittedPath))
    const metadata = await stat(workspacePath, { bigint: true })
    return {
      workspacePath,
      identityKey: metadata.ino > 0n
        ? `fs:${metadata.dev.toString()}:${metadata.ino.toString()}`
        : normalizeWorkspaceIdentityPath(workspacePath),
    }
  } catch {
    // Preserve the existing launch behavior when the path cannot be resolved yet.
    return {
      workspacePath: submittedPath,
      identityKey: normalizeWorkspaceIdentityPath(submittedPath),
    }
  }
}
