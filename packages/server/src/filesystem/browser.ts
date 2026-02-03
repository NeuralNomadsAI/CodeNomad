import fs from "fs"
import os from "os"
import path from "path"
import {
  FileSystemCreateFolderResponse,
  FileSystemEntry,
  FileSystemListResponse,
  FileSystemListingMetadata,
  WINDOWS_DRIVES_ROOT,
} from "../api-types"

interface FileSystemBrowserOptions {
  rootDir: string
  unrestricted?: boolean
}

interface DirectoryReadOptions {
  includeFiles: boolean
  formatPath: (entryName: string) => string
  formatAbsolutePath: (entryName: string) => string
}

const WINDOWS_DRIVE_LETTERS = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i))

export class FileSystemBrowser {
  private readonly root: string
  private readonly unrestricted: boolean
  private readonly homeDir: string
  private readonly isWindows: boolean

  constructor(options: FileSystemBrowserOptions) {
    this.root = path.resolve(options.rootDir)
    this.unrestricted = Boolean(options.unrestricted)
    this.homeDir = os.homedir()
    this.isWindows = process.platform === "win32"
  }

  list(relativePath = ".", options: { includeFiles?: boolean } = {}): FileSystemEntry[] {
    if (this.unrestricted) {
      throw new Error("Relative listing is unavailable when running with unrestricted root")
    }
    const includeFiles = options.includeFiles ?? true
    const normalizedPath = this.normalizeRelativePath(relativePath)
    const absolutePath = this.toRestrictedAbsolute(normalizedPath)
    return this.readDirectoryEntries(absolutePath, {
      includeFiles,
      formatPath: (entryName) => this.buildRelativePath(normalizedPath, entryName),
      formatAbsolutePath: (entryName) => this.resolveRestrictedAbsoluteChild(normalizedPath, entryName),
    })
  }

  browse(targetPath?: string, options: { includeFiles?: boolean } = {}): FileSystemListResponse {
    const includeFiles = options.includeFiles ?? true
    if (this.unrestricted) {
      return this.listUnrestricted(targetPath, includeFiles)
    }
    return this.listRestrictedWithMetadata(targetPath, includeFiles)
  }

  createFolder(parentPath: string | undefined, folderName: string): FileSystemCreateFolderResponse {
    const name = this.normalizeFolderName(folderName)

    if (this.unrestricted) {
      const resolvedParent = this.resolveUnrestrictedPath(parentPath)
      if (this.isWindows && resolvedParent === WINDOWS_DRIVES_ROOT) {
        throw new Error("Cannot create folders at drive root")
      }
      this.assertDirectoryExists(resolvedParent)
      const absolutePath = this.resolveAbsoluteChild(resolvedParent, name)
      fs.mkdirSync(absolutePath)
      return { path: absolutePath, absolutePath }
    }

    const normalizedParent = this.normalizeRelativePath(parentPath)
    const parentAbsolute = this.toRestrictedAbsolute(normalizedParent)
    this.assertDirectoryExists(parentAbsolute)

    const relativePath = this.buildRelativePath(normalizedParent, name)
    const absolutePath = this.toRestrictedAbsolute(relativePath)
    fs.mkdirSync(absolutePath)
    return { path: relativePath, absolutePath }
  }

  readFile(relativePath: string): string {
    if (this.unrestricted) {
      throw new Error("readFile is not available in unrestricted mode")
    }
    const resolved = this.toRestrictedAbsolute(relativePath)
    return fs.readFileSync(resolved, "utf-8")
  }

  private listRestrictedWithMetadata(relativePath: string | undefined, includeFiles: boolean): FileSystemListResponse {
    const normalizedPath = this.normalizeRelativePath(relativePath)
    const absolutePath = this.toRestrictedAbsolute(normalizedPath)
    const entries = this.readDirectoryEntries(absolutePath, {
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

  private listUnrestricted(targetPath: string | undefined, includeFiles: boolean): FileSystemListResponse {
    const resolvedPath = this.resolveUnrestrictedPath(targetPath)

    if (this.isWindows && resolvedPath === WINDOWS_DRIVES_ROOT) {
      return this.listWindowsDrives()
    }

    const entries = this.readDirectoryEntries(resolvedPath, {
      includeFiles,
      formatPath: (entryName) => this.resolveAbsoluteChild(resolvedPath, entryName),
      formatAbsolutePath: (entryName) => this.resolveAbsoluteChild(resolvedPath, entryName),
    })

    const parentPath = this.getUnrestrictedParent(resolvedPath)

    const metadata: FileSystemListingMetadata = {
      scope: "unrestricted",
      currentPath: resolvedPath,
      parentPath,
      rootPath: this.homeDir,
      homePath: this.homeDir,
      displayPath: resolvedPath,
      pathKind: "absolute",
    }

    return { entries, metadata }
  }

  private listWindowsDrives(): FileSystemListResponse {
    if (!this.isWindows) {
      throw new Error("Drive listing is only supported on Windows hosts")
    }

    const entries: FileSystemEntry[] = []
    for (const letter of WINDOWS_DRIVE_LETTERS) {
      const drivePath = `${letter}:\\`
      try {
        if (fs.existsSync(drivePath)) {
          entries.push({
            name: `${letter}:`,
            path: drivePath,
            absolutePath: drivePath,
            type: "directory",
          })
        }
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
      rootPath: this.homeDir,
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

  private assertDirectoryExists(directory: string) {
    if (!fs.existsSync(directory)) {
      throw new Error(`Directory does not exist: ${directory}`)
    }
    const stats = fs.statSync(directory)
    if (!stats.isDirectory()) {
      throw new Error(`Path is not a directory: ${directory}`)
    }
  }

  private readDirectoryEntries(directory: string, options: DirectoryReadOptions): FileSystemEntry[] {
    const dirents = fs.readdirSync(directory, { withFileTypes: true })
    const results: FileSystemEntry[] = []

    for (const entry of dirents) {
      const absoluteEntryPath = path.join(directory, entry.name)
      let stats: fs.Stats
      try {
        // Use fs.statSync (not Dirent.isDirectory) so symlinks to directories
        // are treated as directories in directory-only listings.
        stats = fs.statSync(absoluteEntryPath)
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
        size: isDirectory ? undefined : stats.size,
        modifiedAt: stats.mtime.toISOString(),
      })
    }

    return results.sort((a, b) => a.name.localeCompare(b.name))
  }

  private normalizeRelativePath(input: string | undefined) {
    if (!input || input === "." || input === "./" || input === "/") {
      return "."
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
    if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot) && relativeToRoot !== "") {
      throw new Error("Access outside of root is not allowed")
    }
    return target
  }

  private resolveUnrestrictedPath(input: string | undefined): string {
    if (!input || input === "." || input === "./") {
      return this.homeDir
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
