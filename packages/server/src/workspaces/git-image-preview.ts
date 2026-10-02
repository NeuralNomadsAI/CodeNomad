import { realpath } from "node:fs/promises"
import path from "node:path"
import { FileSystemBrowser } from "../filesystem/browser"
import { runGitProcess } from "./git-process"

const imageTypes: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  gif: "image/gif", svg: "image/svg+xml", ico: "image/x-icon", bmp: "image/bmp", avif: "image/avif",
}
export const gitImageMime = (filePath: string) => imageTypes[path.extname(filePath).slice(1).toLowerCase()]

export async function readGitImageBlob(directory: string, object: string): Promise<string | null> {
  try {
    return await runGitProcess(directory, ["cat-file", "blob", object], {
      encoding: "base64", maxBuffer: 5 * 1024 * 1024, timeout: 15_000, priority: "foreground",
    })
  } catch (error) {
    // Known HEAD/index paths may be absent for additions, deletions or unborn HEAD.
    // Size limits and process failures remain errors, not missing images.
    const failure = error as { code?: unknown; stderr?: string }
    if (failure.code === 128 && /does not exist|not in|invalid object name|not a valid object name|could not get object info/i.test(failure.stderr ?? "")) return null
    throw error
  }
}

export async function readWorktreeImage(directory: string, filePath: string): Promise<string | null> {
  try {
    const root = await realpath(directory)
    const resolved = await realpath(path.join(root, filePath))
    const relative = path.relative(root, resolved)
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Image is outside the worktree")
    return (await new FileSystemBrowser({ rootDir: root }).readFileContent(relative, { encoding: "base64" })).contents
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}
