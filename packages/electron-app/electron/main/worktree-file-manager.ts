import { spawn } from "node:child_process"
import { realpath, stat } from "node:fs/promises"
import path from "node:path"
import { TextDecoder } from "node:util"
import type { IpcMainInvokeEvent } from "electron"

const GIT_TIMEOUT_MS = 5_000
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024

export interface WorktreeFileManagerRequest {
  rootDirectory: string
  registeredDirectory: string
  targetDirectory: string
}

interface Dependencies {
  authorize(): void
  canonicalize(value: string): Promise<string>
  inventory(root: string): Promise<string[]>
  openPath(value: string): Promise<string>
  isDirectory(value: string): Promise<boolean>
  platform: NodeJS.Platform
}

interface IPCRegistrar {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void
}

export function validateRegisteredDirectory(value: unknown, platform: NodeJS.Platform): string {
  if (typeof value !== "string" || !value || /[\x00-\x1f\x7f-\x9f]/.test(value)) {
    throw new Error("Worktree directory must be a valid absolute local path")
  }
  if (value.startsWith("\\\\") || value.startsWith("//")) {
    throw new Error("Network and device paths are not allowed")
  }
  if (platform === "win32") {
    const components = value.slice(3).split(/[\\/]/).filter(Boolean)
    if (
      !/^[A-Za-z]:[\\/]/.test(value) ||
      /[:<>"|?*]/.test(value.slice(2)) ||
      components.some((component) =>
        component === "." || component === ".." || /[ .]$/.test(component) ||
        /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM(?:[1-9¹²³])|LPT(?:[1-9¹²³]))(?:\..*)?$/i.test(component)
      )
    ) {
      throw new Error("Worktree directory must be an absolute drive path")
    }
  } else {
    if (!path.posix.isAbsolute(value)) throw new Error("Worktree directory must be absolute")
    if (value === "/dev" || value.startsWith("/dev/")) throw new Error("Device paths are not allowed")
  }
  return value
}

export function parseWorktreeInventory(output: Buffer): string[] {
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const entries: string[] = []
  for (const field of output.toString("binary").split("\0")) {
    if (!field) continue
    const bytes = Buffer.from(field, "binary")
    const value = decoder.decode(bytes)
    if (value.startsWith("worktree ")) entries.push(value.slice("worktree ".length))
  }
  if (!entries.length) throw new Error("Git returned an empty worktree inventory")
  return entries
}

function sameCanonicalPath(left: string, right: string, platform: NodeJS.Platform): boolean {
  return left === right
}

async function verifyInventory(request: WorktreeFileManagerRequest, dependencies: Dependencies): Promise<string> {
  const rootInput = validateRegisteredDirectory(request.rootDirectory, dependencies.platform)
  const registeredInput = validateRegisteredDirectory(request.registeredDirectory, dependencies.platform)
  const targetInput = validateRegisteredDirectory(request.targetDirectory, dependencies.platform)
  const [root, registered, target] = (await Promise.all([
    dependencies.canonicalize(rootInput),
    dependencies.canonicalize(registeredInput),
    dependencies.canonicalize(targetInput),
  ])).map((entry) => validateRegisteredDirectory(entry, dependencies.platform))
  const inventory = await dependencies.inventory(root)
  const canonicalInventory = await Promise.all(inventory.map(async (entry) => {
    const input = validateRegisteredDirectory(entry, dependencies.platform)
    return validateRegisteredDirectory(await dependencies.canonicalize(input), dependencies.platform)
  }))
  if (!canonicalInventory.some((entry) => sameCanonicalPath(entry, root, dependencies.platform))) {
    throw new Error("Workspace root is not registered in the Git worktree inventory")
  }
  if (!canonicalInventory.some((entry) => sameCanonicalPath(entry, registered, dependencies.platform))) {
    throw new Error("Worktree is not registered in the Git worktree inventory")
  }
  const pathApi = dependencies.platform === "win32" ? path.win32 : path.posix
  const relativeTarget = pathApi.relative(registered, target)
  if (relativeTarget === ".." || relativeTarget.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relativeTarget)) {
    throw new Error("Worktree target is outside the registered directory")
  }
  if (!await dependencies.isDirectory(target)) throw new Error("Worktree target must be a directory")
  return target
}

export async function authorizeOpenWorktree(
  request: WorktreeFileManagerRequest,
  dependencies: Dependencies,
): Promise<void> {
  dependencies.authorize()
  await verifyInventory(request, dependencies)
  dependencies.authorize()
  const target = await verifyInventory(request, dependencies)
  dependencies.authorize()
  const error = await dependencies.openPath(target)
  if (error) throw new Error(error)
}

export function readGitWorktreeInventory(root: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", root, "worktree", "list", "--porcelain", "-z"], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      child.kill()
      reject(error)
    }
    const timer = setTimeout(() => fail(new Error("Git worktree inventory timed out")), GIT_TIMEOUT_MS)
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > MAX_GIT_OUTPUT_BYTES) fail(new Error("Git worktree inventory output exceeded the limit"))
      else stdout.push(chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length
      if (stderrBytes > MAX_GIT_OUTPUT_BYTES) fail(new Error("Git worktree inventory error output exceeded the limit"))
      else stderr.push(chunk)
    })
    child.once("error", fail)
    child.once("close", (code) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      if (code !== 0) {
        reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || "Git worktree inventory failed"))
        return
      }
      try {
        resolve(parseWorktreeInventory(Buffer.concat(stdout)))
      } catch (error) {
        reject(error)
      }
    })
  })
}

export function setupWorktreeFileManagerIPC(
  ipcMain: IPCRegistrar,
  authorize: (event: IpcMainInvokeEvent, token: unknown) => void,
  openPath: (value: string) => Promise<string>,
): void {
  ipcMain.handle("worktree:openInFileManager", async (event, token, request) => {
    if (!request || typeof request !== "object") throw new Error("Invalid worktree request")
    const value = request as WorktreeFileManagerRequest
    await authorizeOpenWorktree(value, {
      authorize: () => authorize(event, token),
      canonicalize: realpath,
      inventory: readGitWorktreeInventory,
      openPath,
      isDirectory: async (value) => (await stat(value)).isDirectory(),
      platform: process.platform,
    })
  })
}
