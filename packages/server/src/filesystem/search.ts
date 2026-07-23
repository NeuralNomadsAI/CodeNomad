import fs from "fs"
import path from "path"
import fuzzysort from "fuzzysort"
import type { FileSystemEntry } from "../api-types"
import { clearWorkspaceSearchCache, getWorkspaceCandidates, refreshWorkspaceCandidates } from "./search-cache"

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 200
const MAX_CANDIDATES = 8000
const IGNORED_DIRECTORIES = new Set(
  [".git", ".hg", ".svn", "node_modules", "dist", "build", ".next", ".nuxt", ".turbo", ".cache", "coverage"].map(
    (name) => name.toLowerCase(),
  ),
)

export type WorkspaceFileSearchType = "all" | "file" | "directory"

export interface WorkspaceFileSearchOptions {
  limit?: number
  type?: WorkspaceFileSearchType
  refresh?: boolean
}

interface CandidateEntry {
  entry: FileSystemEntry
  key: string
}

export function searchWorkspaceFiles(
  rootDir: string,
  query: string,
  options: WorkspaceFileSearchOptions = {},
): FileSystemEntry[] {
  const trimmedQuery = query.trim()
  if (!trimmedQuery) {
    throw new Error("Search query is required")
  }

  const normalizedRoot = path.resolve(rootDir)
  const limit = normalizeLimit(options.limit)
  const typeFilter: WorkspaceFileSearchType = options.type ?? "all"
  const refreshRequested = options.refresh === true
  const cacheScope = `${typeFilter}\0${trimmedQuery.toLowerCase()}`

  let entries: FileSystemEntry[] | undefined

  try {
    if (!refreshRequested) {
      entries = getWorkspaceCandidates(normalizedRoot, cacheScope)
    }

    if (!entries) {
      entries = refreshWorkspaceCandidates(normalizedRoot, cacheScope, () =>
        collectCandidates(normalizedRoot, trimmedQuery, typeFilter),
      )
    }
  } catch (error) {
    clearWorkspaceSearchCache(normalizedRoot)
    throw error
  }

  if (!entries || entries.length === 0) {
    return []
  }

  const candidates = buildCandidateEntries(entries, typeFilter)

  if (candidates.length === 0) {
    return []
  }

  const matches = fuzzysort.go<CandidateEntry>(trimmedQuery, candidates, {
    key: "key",
    limit,
  })

  if (!matches || matches.length === 0) {
    return []
  }

  return matches.map((match) => match.obj.entry)
}


function collectCandidates(rootDir: string, query: string, filter: WorkspaceFileSearchType): FileSystemEntry[] {
  const queue: Array<{ relativeDir: string; ancestors: ReadonlySet<string> }> = [
    { relativeDir: "", ancestors: new Set() },
  ]
  const entries: FileSystemEntry[] = []

  while (queue.length > 0 && entries.length < MAX_CANDIDATES) {
    const queuedDirectory = queue.pop()!
    const { relativeDir, ancestors } = queuedDirectory
    const absoluteDir = relativeDir ? path.join(rootDir, relativeDir) : rootDir

    let dirents: fs.Dirent[]
    let branchAncestors: ReadonlySet<string>
    try {
      const realDir = normalizeDirectoryIdentity(fs.realpathSync.native(absoluteDir))
      if (ancestors.has(realDir)) {
        continue
      }
      branchAncestors = new Set([...ancestors, realDir])
      dirents = fs.readdirSync(absoluteDir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const dirent of dirents) {
      const entryName = dirent.name
      const lowerName = entryName.toLowerCase()
      const relativePath = relativeDir ? `${relativeDir}/${entryName}` : entryName
      const absolutePath = path.join(absoluteDir, entryName)

      if (dirent.isDirectory() && IGNORED_DIRECTORIES.has(lowerName)) {
        continue
      }

      let stats: fs.Stats
      try {
        stats = fs.statSync(absolutePath)
      } catch {
        continue
      }

      const isDirectory = stats.isDirectory()

      if (isDirectory && !IGNORED_DIRECTORIES.has(lowerName)) {
        queue.push({ relativeDir: relativePath, ancestors: branchAncestors })
      }

      const entryType: FileSystemEntry["type"] = isDirectory ? "directory" : "file"
      const normalizedPath = normalizeRelativeEntryPath(relativePath)
      const entry: FileSystemEntry = {
        name: entryName,
        path: normalizedPath,
        absolutePath: path.resolve(rootDir, normalizedPath === "." ? "" : normalizedPath),
        type: entryType,
        size: entryType === "file" ? stats.size : undefined,
        modifiedAt: stats.mtime.toISOString(),
      }

      if (!shouldInclude(entry.type, filter) || !fuzzysort.single(query, buildSearchKey(entry))) {
        continue
      }

      entries.push(entry)
      if (entries.length >= MAX_CANDIDATES) {
        break
      }
    }
  }

  return entries
}

function buildCandidateEntries(entries: FileSystemEntry[], filter: WorkspaceFileSearchType): CandidateEntry[] {
  const filtered: CandidateEntry[] = []
  for (const entry of entries) {
    if (!shouldInclude(entry.type, filter)) {
      continue
    }
    filtered.push({ entry, key: buildSearchKey(entry) })
  }
  return filtered
}

function normalizeLimit(limit?: number) {
  if (!limit || Number.isNaN(limit)) {
    return DEFAULT_LIMIT
  }
  const clamped = Math.min(Math.max(limit, 1), MAX_LIMIT)
  return clamped
}

function shouldInclude(entryType: FileSystemEntry["type"], filter: WorkspaceFileSearchType) {
  return filter === "all" || entryType === filter
}

function normalizeRelativeEntryPath(relativePath: string): string {
  if (!relativePath) {
    return "."
  }
  let normalized = relativePath.replace(/\\+/g, "/")
  if (normalized.startsWith("./")) {
    normalized = normalized.replace(/^\.\/+/, "")
  }
  if (normalized.startsWith("/")) {
    normalized = normalized.replace(/^\/+/g, "")
  }
  return normalized || "."
}

function buildSearchKey(entry: FileSystemEntry) {
  return entry.path.toLowerCase()
}

function normalizeDirectoryIdentity(directoryPath: string) {
  return process.platform === "win32" ? directoryPath.toLowerCase() : directoryPath
}
