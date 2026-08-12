import { realpath, stat } from "node:fs/promises"
import path from "node:path"

function withoutWindowsExtendedPrefix(value: string): string {
  return value.replace(/^\\\\\?\\UNC[\\/]/i, "\\\\").replace(/^\\\\\?\\/, "")
}

export function normalizeWorkspaceIdentityPath(value: string, platform: NodeJS.Platform = process.platform): string {
  const pathApi = platform === "win32" ? path.win32 : path.posix
  const normalized = pathApi.normalize(platform === "win32" ? withoutWindowsExtendedPrefix(value) : value)
  return platform === "win32" ? normalized.toLowerCase() : normalized
}

export async function canonicalWorkspacePath(value: string): Promise<string> {
  const absolutePath = path.resolve(value)
  let ancestor = absolutePath
  const suffix: string[] = []
  while (true) {
    try {
      return path.resolve(await realpath(ancestor), ...suffix.reverse())
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return absolutePath
      const parent = path.dirname(ancestor)
      if (parent === ancestor) return absolutePath
      suffix.push(path.basename(ancestor))
      ancestor = parent
    }
  }
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
    const workspacePath = await canonicalWorkspacePath(submittedPath)
    return {
      workspacePath,
      identityKey: normalizeWorkspaceIdentityPath(workspacePath),
    }
  }
}
