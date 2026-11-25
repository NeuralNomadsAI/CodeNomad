import { createHash, randomUUID } from "node:crypto"
import fs from "fs"
import os from "os"
import path from "path"
import { withFileAccess } from "./file-access"
import {
  FileSystemCreateFolderResponse,
  FileSystemEntry,
  FileSystemFileContentResponse,
  FileSystemListResponse,
  FileSystemListingMetadata,
  WINDOWS_DRIVES_ROOT,
} from "../api-types"

interface FileSystemBrowserOptions {
  rootDir: string
  unrestricted?: boolean
  platform?: NodeJS.Platform
}

interface DirectoryReadOptions {
  includeFiles: boolean
  formatPath: (entryName: string) => string
  formatAbsolutePath: (entryName: string) => string
}

const WINDOWS_DRIVE_LETTERS = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i))
const MAX_READABLE_FILE_BYTES = 5 * 1024 * 1024
const RENAME_FALLBACK_CODES = new Set(["EACCES", "EPERM", "EBUSY", "EXDEV", "ENOSYS", "ENOTSUP"])

export function fileVersion(bytes: Uint8Array): string {
  return `"${createHash("sha256").update(bytes).digest("hex")}"`
}

export class FileChangedError extends Error {
  readonly statusCode = 409

  constructor(message = "File changed on disk") {
    super(message)
    this.name = "FileChangedError"
  }
}

function isRenameFallbackError(error: unknown): boolean {
  if (error instanceof FileChangedError) return false
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof code === "string" && RENAME_FALLBACK_CODES.has(code)
}

export class FileSystemBrowser {
  private readonly root: string
  private readonly unrestricted: boolean
  private readonly homeDir: string
  private readonly isWindows: boolean

  constructor(options: FileSystemBrowserOptions) {
    this.root = path.resolve(options.rootDir)
    this.unrestricted = Boolean(options.unrestricted)
    this.homeDir = os.homedir()
    this.isWindows = (options.platform ?? process.platform) === "win32"
  }

  async list(relativePath = ".", options: { includeFiles?: boolean; observeDirectory?: (directory: string) => Promise<void> } = {}): Promise<FileSystemEntry[]> {
    if (this.unrestricted) {
      throw new Error("Relative listing is unavailable when running with unrestricted root")
    }
    const includeFiles = options.includeFiles ?? true
    const normalizedPath = this.normalizeRelativePath(relativePath)
    const absolutePath = this.toRestrictedAbsolute(normalizedPath)
    await options.observeDirectory?.(absolutePath)
    return this.readDirectoryEntries(absolutePath, {
      includeFiles,
      formatPath: (entryName) => this.buildRelativePath(normalizedPath, entryName),
      formatAbsolutePath: (entryName) => this.resolveRestrictedAbsoluteChild(normalizedPath, entryName),
    })
  }

  async browse(targetPath?: string, options: { includeFiles?: boolean } = {}): Promise<FileSystemListResponse> {
    const includeFiles = options.includeFiles ?? true
    if (this.unrestricted) {
      return this.listUnrestricted(targetPath, includeFiles)
    }
    return this.listRestrictedWithMetadata(targetPath, includeFiles)
  }

  async createFolder(parentPath: string | undefined, folderName: string): Promise<FileSystemCreateFolderResponse> {
    const name = this.normalizeFolderName(folderName)

    if (this.unrestricted) {
      const resolvedParent = this.resolveUnrestrictedPath(parentPath)
      if (this.isWindows && resolvedParent === WINDOWS_DRIVES_ROOT) {
        throw new Error("Cannot create folders at drive root")
      }
      await this.assertDirectoryExists(resolvedParent)
      const absolutePath = this.resolveAbsoluteChild(resolvedParent, name)
      await fs.promises.mkdir(absolutePath)
      return { path: absolutePath, absolutePath }
    }

    const normalizedParent = this.normalizeRelativePath(parentPath)
    const parentAbsolute = this.toRestrictedAbsolute(normalizedParent)
    await this.assertDirectoryExists(parentAbsolute)

    const relativePath = this.buildRelativePath(normalizedParent, name)
    const absolutePath = this.toRestrictedAbsolute(relativePath)
    await fs.promises.mkdir(absolutePath)
    return { path: relativePath, absolutePath }
  }

  async writeFile(relativePath: string, contents: string, options?: { expectedVersion?: string }): Promise<string> {
    if (this.unrestricted) {
      throw new Error("writeFile is not available in unrestricted mode")
    }
    const bytes = Buffer.from(contents, "utf-8")
    if (bytes.length > MAX_READABLE_FILE_BYTES) {
      throw new Error("Selected file is too large to attach")
    }
    const resolved = this.toRestrictedAbsolute(relativePath)
    const expectedVersion = options?.expectedVersion
    return withFileAccess(resolved, async () => {
      const inspectTarget = async (): Promise<{ stats: fs.Stats; targetPath: string } | null> => {
        let linkStats: fs.Stats
        try {
          linkStats = await fs.promises.lstat(resolved)
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null
          throw error
        }
        if (linkStats.isSymbolicLink()) {
          let targetPath: string
          try {
            targetPath = await fs.promises.realpath(resolved)
          } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null
            throw error
          }
          const stats = await fs.promises.stat(targetPath)
          if (!stats.isFile()) {
            if (expectedVersion !== undefined) throw new FileChangedError()
            throw new Error("Selected path is not a file")
          }
          return { stats, targetPath }
        }
        if (!linkStats.isFile()) {
          if (expectedVersion !== undefined) throw new FileChangedError()
          throw new Error("Selected path is not a file")
        }
        return { stats: linkStats, targetPath: resolved }
      }

      const verifyVersion = async (existing: { stats: fs.Stats; targetPath: string } | null) => {
        if (expectedVersion === undefined) return
        if (!existing || existing.stats.size > MAX_READABLE_FILE_BYTES) {
          throw new FileChangedError()
        }
        let currentBytes: Buffer
        try {
          currentBytes = await fs.promises.readFile(existing.targetPath)
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw new FileChangedError()
          throw error
        }
        if (fileVersion(currentBytes) !== expectedVersion) {
          throw new FileChangedError()
        }
      }

      const existing = await inspectTarget()
      await verifyVersion(existing)

      const nextVersion = fileVersion(bytes)
      const targetPath = existing?.targetPath ?? resolved

      const writeInPlace = async () => {
        const handle = await fs.promises.open(targetPath, "r+")
        try {
          let written = 0
          while (written < bytes.length) {
            const { bytesWritten } = await handle.write(bytes, written, bytes.length - written, written)
            written += bytesWritten
          }
          await handle.truncate(bytes.length)
          await handle.sync()
        } finally {
          await handle.close()
        }
      }

      if (existing && existing.stats.nlink > 1) {
        await writeInPlace()
        return nextVersion
      }

      const tempPath = path.join(path.dirname(targetPath), `.codenomad-tmp-${process.pid}-${randomUUID()}`)
      const mode = existing && !this.isWindows ? existing.stats.mode & 0o777 : undefined
      let tempCreated = false
      try {
        const handle = await fs.promises.open(tempPath, "wx", mode)
        tempCreated = true
        try {
          if (mode !== undefined) {
            await handle.chmod(mode)
          }
          await handle.writeFile(bytes)
          await handle.sync()
        } finally {
          await handle.close()
        }
        if (expectedVersion !== undefined) {
          const latest = await inspectTarget()
          if (!latest || latest.targetPath !== targetPath || latest.stats.nlink !== existing?.stats.nlink) {
            throw new FileChangedError()
          }
          await verifyVersion(latest)
        }
        await fs.promises.rename(tempPath, targetPath)
        tempCreated = false
      } catch (error) {
        if (tempCreated) {
          await fs.promises.unlink(tempPath).catch(() => {})
        }
        if (existing && isRenameFallbackError(error)) {
          const latest = await inspectTarget()
          if (!latest || latest.targetPath !== targetPath) throw new FileChangedError()
          await verifyVersion(latest)
          await writeInPlace()
          return nextVersion
        }
        throw error
      }
      return nextVersion
    })
  }

  async readFile(relativePath: string): Promise<string> {
    if (this.unrestricted) {
      throw new Error("readFile is not available in unrestricted mode")
    }
    const resolved = this.toRestrictedAbsolute(relativePath)
    return withFileAccess(resolved, () => fs.promises.readFile(resolved, "utf-8"))
  }

  async readFileBase64(relativePath: string): Promise<string> {
    if (this.unrestricted) {
      throw new Error("readFileBase64 is not available in unrestricted mode")
    }
    const resolved = this.toRestrictedAbsolute(relativePath)
    return withFileAccess(resolved, async () => (await fs.promises.readFile(resolved)).toString("base64"))
  }

  async readFileContent(targetPath: string, options?: { encoding?: "utf-8" | "base64" }): Promise<FileSystemFileContentResponse> {
    const encoding = options?.encoding ?? "utf-8"
    const resolved = this.unrestricted ? this.resolveUnrestrictedPath(targetPath) : this.toRestrictedAbsolute(targetPath)
    return withFileAccess(resolved, async () => {
      const stats = await fs.promises.stat(resolved)
      if (!stats.isFile()) {
        throw new Error("Selected path is not a file")
      }
      if (stats.size > MAX_READABLE_FILE_BYTES) {
        throw new Error("Selected file is too large to attach")
      }
      const buffer = await fs.promises.readFile(resolved)
      if (buffer.length > MAX_READABLE_FILE_BYTES) {
        throw new Error("Selected file is too large to attach")
      }
      return { path: targetPath, contents: buffer.toString(encoding), encoding, version: fileVersion(buffer) }
    })
  }

  private async listRestrictedWithMetadata(relativePath: string | undefined, includeFiles: boolean): Promise<FileSystemListResponse> {
    const normalizedPath = this.normalizeRelativePath(relativePath)
    const absolutePath = this.toRestrictedAbsolute(normalizedPath)
    const entries = await this.readDirectoryEntries(absolutePath, {
      includeFiles,
      formatPath: (entryName) => this.buildRelativePath(normalizedPath, entryName),
      formatAbsolutePath: (entryName) => this.resolveRestrictedAbsoluteChild(normalizedPath, entryName),
    })

    const metadata: FileSystemListingMetadata = {
      scope: "restricted",
      currentPath: normalizedPath,
      parentPath: normalizedPath === "." ? undefined : this.getRestrictedParent(normalizedPath),
      rootPath: this.root,
      homePath: this.homeDir,
      displayPath: this.resolveRestrictedAbsolute(normalizedPath),
      pathKind: "relative",
    }

    return { entries, metadata }
  }

  private async listUnrestricted(targetPath: string | undefined, includeFiles: boolean): Promise<FileSystemListResponse> {
    const resolvedPath = this.resolveUnrestrictedPath(targetPath)

    if (this.isWindows && resolvedPath === WINDOWS_DRIVES_ROOT) {
      return this.listWindowsDrives()
    }

    const entries = await this.readDirectoryEntries(resolvedPath, {
      includeFiles,
      formatPath: (entryName) => this.resolveAbsoluteChild(resolvedPath, entryName),
      formatAbsolutePath: (entryName) => this.resolveAbsoluteChild(resolvedPath, entryName),
    })

    const parentPath = this.getUnrestrictedParent(resolvedPath)

    const metadata: FileSystemListingMetadata = {
      scope: "unrestricted",
      currentPath: resolvedPath,
      parentPath,
      rootPath: this.root,
      homePath: this.homeDir,
      displayPath: resolvedPath,
      pathKind: "absolute",
    }

    return { entries, metadata }
  }

  private async listWindowsDrives(): Promise<FileSystemListResponse> {
    if (!this.isWindows) {
      throw new Error("Drive listing is only supported on Windows hosts")
    }

    const entries: FileSystemEntry[] = []
    for (const letter of WINDOWS_DRIVE_LETTERS) {
      const drivePath = `${letter}:\\`
      try {
        await fs.promises.access(drivePath)
        entries.push({
          name: `${letter}:`,
          path: drivePath,
          absolutePath: drivePath,
          type: "directory",
        })
      } catch {
        // Ignore inaccessible drives
      }
    }

    // Provide a generic UNC root entry so users can navigate to network shares manually.
    entries.push({
      name: "UNC Network",
      path: "\\\\",
      absolutePath: "\\\\",
      type: "directory",
    })

    const metadata: FileSystemListingMetadata = {
      scope: "unrestricted",
      currentPath: WINDOWS_DRIVES_ROOT,
      parentPath: undefined,
      rootPath: this.root,
      homePath: this.homeDir,
      displayPath: "Drives",
      pathKind: "drives",
    }

    return { entries, metadata }
  }

  private normalizeFolderName(input: string): string {
    const name = input.trim()
    if (!name) {
      throw new Error("Folder name is required")
    }

    if (name === "." || name === "..") {
      throw new Error("Invalid folder name")
    }

    if (name.startsWith("~")) {
      throw new Error("Invalid folder name")
    }

    if (name.includes("/") || name.includes("\\")) {
      throw new Error("Folder name must not include path separators")
    }

    if (name.includes("\u0000")) {
      throw new Error("Invalid folder name")
    }

    return name
  }

  private async assertDirectoryExists(directory: string) {
    const stats = await fs.promises.stat(directory)
    if (!stats.isDirectory()) {
      throw new Error(`Path is not a directory: ${directory}`)
    }
  }

  private async readDirectoryEntries(directory: string, options: DirectoryReadOptions): Promise<FileSystemEntry[]> {
    const dirents = await fs.promises.readdir(directory, { withFileTypes: true })
    const results: FileSystemEntry[] = []

    for (const entry of dirents) {
      const absoluteEntryPath = path.join(directory, entry.name)
      let stats: fs.BigIntStats
      try {
        // Follow symlinks so linked directories remain visible in folder listings.
        stats = await fs.promises.stat(absoluteEntryPath, { bigint: true })
      } catch {
        // Skip entries we cannot stat (insufficient permissions, etc.)
        continue
      }

      const isDirectory = stats.isDirectory()
      if (!options.includeFiles && !isDirectory) {
        continue
      }

      results.push({
        name: entry.name,
        path: options.formatPath(entry.name),
        absolutePath: options.formatAbsolutePath(entry.name),
        type: isDirectory ? "directory" : "file",
        ...(isDirectory ? { directoryIdentity: `${stats.dev}:${stats.ino}` } : {}),
        size: isDirectory ? undefined : Number(stats.size),
        modifiedAt: stats.mtime.toISOString(),
      })
    }

    return results.sort((a, b) => a.name.localeCompare(b.name))
  }

  private normalizeRelativePath(input: string | undefined) {
    if (!input || input === "." || input === "./" || input === "/") {
      return "."
    }

    if (path.isAbsolute(input)) {
      const resolved = path.resolve(input)
      const relativeToRoot = path.relative(this.root, resolved)
      if (relativeToRoot === "") {
        return "."
      }
      if (this.isOutsideRoot(relativeToRoot)) {
        throw new Error("Access outside of root is not allowed")
      }
      return relativeToRoot.replace(/\\+/g, "/")
    }

    let normalized = input.replace(/\\+/g, "/")
    if (normalized.startsWith("./")) {
      normalized = normalized.replace(/^\.\/+/, "")
    }
    if (normalized.startsWith("/")) {
      normalized = normalized.replace(/^\/+/g, "")
    }
    return normalized === "" ? "." : normalized
  }

  private buildRelativePath(parent: string, child: string) {
    if (!parent || parent === ".") {
      return this.normalizeRelativePath(child)
    }
    return this.normalizeRelativePath(`${parent}/${child}`)
  }

  private resolveRestrictedAbsolute(relativePath: string) {
    return this.toRestrictedAbsolute(relativePath)
  }

  private resolveRestrictedAbsoluteChild(parent: string, child: string) {
    const normalized = this.buildRelativePath(parent, child)
    return this.toRestrictedAbsolute(normalized)
  }

  private toRestrictedAbsolute(relativePath: string) {
    const normalized = this.normalizeRelativePath(relativePath)
    const target = path.resolve(this.root, normalized)
    const relativeToRoot = path.relative(this.root, target)
    if (this.isOutsideRoot(relativeToRoot)) {
      throw new Error("Access outside of root is not allowed")
    }
    return target
  }

  private isOutsideRoot(relativeToRoot: string) {
    return relativeToRoot === ".." || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)
  }

  private resolveUnrestrictedPath(input: string | undefined): string {
    if (!input || input === "." || input === "./") {
      return this.root
    }

    if (this.isWindows) {
      if (input === WINDOWS_DRIVES_ROOT) {
        return WINDOWS_DRIVES_ROOT
      }
      const normalized = path.win32.normalize(input)
      if (/^[a-zA-Z]:/.test(normalized) || normalized.startsWith("\\\\")) {
        return normalized
      }
      return path.win32.resolve(this.homeDir, normalized)
    }

    if (input.startsWith("/")) {
      return path.posix.normalize(input)
    }

    return path.posix.resolve(this.homeDir, input)
  }

  private resolveAbsoluteChild(parent: string, child: string) {
    if (this.isWindows) {
      return path.win32.normalize(path.win32.join(parent, child))
    }
    return path.posix.normalize(path.posix.join(parent, child))
  }

  private getRestrictedParent(relativePath: string) {
    const normalized = this.normalizeRelativePath(relativePath)
    if (normalized === ".") {
      return undefined
    }
    const segments = normalized.split("/")
    segments.pop()
    return segments.length === 0 ? "." : segments.join("/")
  }

  private getUnrestrictedParent(currentPath: string) {
    if (this.isWindows) {
      const normalized = path.win32.normalize(currentPath)
      const parsed = path.win32.parse(normalized)
      if (normalized === WINDOWS_DRIVES_ROOT) {
        return undefined
      }
      if (normalized === parsed.root) {
        return WINDOWS_DRIVES_ROOT
      }
      return path.win32.dirname(normalized)
    }

    const normalized = path.posix.normalize(currentPath)
    if (normalized === "/") {
      return undefined
    }
    return path.posix.dirname(normalized)
  }
}
