// prototype-1236: read-only Files and Changes of a project on an explicit OpenCode server.
// Every read goes through the project's single server connection, never the host disk or Git.
import type { FileSystemEntry, WorkspaceFileResponse, WorktreeGitDiffResponse, WorktreeGitStatusEntry } from "../../api-types"
import type { ServiceConnection } from "../../workspaces/opencode-service"

export const REMOTE_FILE_READ_LIMIT = 5 * 1024 * 1024
const JSON_LIMIT = 32 * 1024 * 1024
const MAX_ENTRIES = 5_000
const MAX_PATH = 4_096
// Whole-file context: one hunk reconstructs both sides exactly.
const FULL_CONTEXT = 1_000_000

export class RemoteWorkspaceError extends Error {
  constructor(readonly code: "invalid_path" | "not_found" | "too_large" | "unavailable" | "ambiguous" | "not_repository", readonly status: number) {
    super(code)
    this.name = "RemoteWorkspaceError"
  }
}

type Reader = Pick<ServiceConnection, "endpoint" | "fetch" | "assertCurrent">

/** A path relative to the opened folder: "." or slash-separated segments, never absolute nor `..`. */
export function remoteRelativePath(value: unknown): string {
  if (value === undefined || value === "") return "."
  if (typeof value !== "string" || value.length > MAX_PATH || value.includes("\0")) throw new RemoteWorkspaceError("invalid_path", 400)
  const normalized = value.replace(/\\/g, "/")
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) throw new RemoteWorkspaceError("invalid_path", 400)
  const segments = normalized.split("/").filter(segment => segment !== "" && segment !== ".")
  if (segments.some(segment => segment === "..")) throw new RemoteWorkspaceError("invalid_path", 400)
  return segments.join("/") || "."
}

/** Filters what a native listing reports: only relative names inside the folder (Q1, exactness). */
function insideEntry(path: unknown): string | undefined {
  if (typeof path !== "string") return undefined
  try {
    const relative = remoteRelativePath(path)
    return relative === "." ? undefined : relative
  } catch { return undefined }
}

async function readBounded(reader: Reader, path: string, query: Record<string, string>, limit: number, signal: AbortSignal) {
  const url = new URL(path, reader.endpoint.url)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  reader.assertCurrent()
  const response = await reader.fetch(url.toString(), { signal, redirect: "error", headers: { accept: "application/json, application/octet-stream" } })
  reader.assertCurrent()
  const body = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (body) {
      const chunk = await body.read()
      reader.assertCurrent()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > limit) throw new RemoteWorkspaceError("too_large", 413)
      chunks.push(chunk.value)
    }
  } catch (error) { await body?.cancel().catch(() => {}); throw error }
  finally { body?.releaseLock() }
  if (response.status === 404) throw new RemoteWorkspaceError("not_found", 404)
  if (!response.ok) throw new RemoteWorkspaceError("unavailable", 502)
  return { bytes: Buffer.concat(chunks, size), type: response.headers.get("content-type") ?? "" }
}

/** One bounded native JSON read for the exact folder; the answer must name that folder. */
export async function readJson(reader: Reader, path: string, query: Record<string, string>, directory: string, signal: AbortSignal) {
  const { bytes } = await readBounded(reader, path, { ...query, "location[directory]": directory }, JSON_LIMIT, signal)
  let value: any
  try { value = JSON.parse(bytes.toString("utf8")) } catch { throw new RemoteWorkspaceError("unavailable", 502) }
  // Every answer must be for the exact opened folder.
  if (!value || typeof value !== "object" || value.location?.directory !== directory || value.location.workspaceID !== undefined) {
    throw new RemoteWorkspaceError("unavailable", 502)
  }
  return value
}

function nameOf(path: string) { return path.split("/").at(-1)! }

function entries(data: unknown, parent?: string): FileSystemEntry[] {
  if (!Array.isArray(data)) throw new RemoteWorkspaceError("unavailable", 502)
  const seen = new Set<string>(), result: FileSystemEntry[] = []
  for (const entry of data.slice(0, MAX_ENTRIES)) {
    const path = insideEntry(entry?.path)
    if (!path || (entry.type !== "file" && entry.type !== "directory") || seen.has(path)) continue
    if (parent !== undefined && (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".") !== parent) continue
    seen.add(path)
    result.push({ name: nameOf(path), path, type: entry.type })
  }
  return result
}

export async function listRemoteFiles(reader: Reader, directory: string, relativePath: unknown, signal: AbortSignal): Promise<FileSystemEntry[]> {
  const path = remoteRelativePath(relativePath)
  const value = await readJson(reader, "/api/fs/list", { path }, directory, signal)
  return entries(value.data, path).sort((a, b) => a.name.localeCompare(b.name))
}

export async function searchRemoteFiles(reader: Reader, directory: string, query: string, options: { limit?: number; type?: "all" | "file" | "directory" }, signal: AbortSignal) {
  const value = await readJson(reader, "/api/fs/find", {
    query, limit: String(Math.min(Math.max(options.limit ?? 100, 1), 1_000)),
    ...(options.type && options.type !== "all" ? { type: options.type } : {}),
  }, directory, signal)
  return entries(value.data)
}

export async function readRemoteFile(reader: Reader, workspaceId: string, directory: string, relativePath: unknown, encoding: "utf-8" | "base64", signal: AbortSignal): Promise<WorkspaceFileResponse> {
  const path = remoteRelativePath(relativePath)
  if (path === ".") throw new RemoteWorkspaceError("invalid_path", 400)
  const encoded = path.split("/").map(encodeURIComponent).join("/")
  const { bytes } = await readBounded(reader, `/api/fs/read/${encoded}`, { "location[directory]": directory }, REMOTE_FILE_READ_LIMIT, signal)
  return { workspaceId, relativePath: path, contents: bytes.toString(encoding === "base64" ? "base64" : "utf8"), encoding }
}

const slash = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "")

/** The opened folder relative to the Git worktree root ("" or "a/b/"), undefined when it is not inside it. */
export function locationPrefix(root: string, directory: string): string | undefined {
  const r = slash(root), d = slash(directory)
  const fold = /^[A-Za-z]:/.test(r) ? (value: string) => value.toLowerCase() : (value: string) => value
  if (fold(r) === fold(d)) return ""
  if (r === "" ) return d.startsWith("/") && d.length > 1 ? `${d.slice(1)}/` : undefined
  return fold(d).startsWith(`${fold(r)}/`) ? `${d.slice(r.length + 1)}/` : undefined
}

type NativeDiff = { file: string; patch: string; additions: number; deletions: number; status: "added" | "deleted" | "modified"; more?: true }

async function workingDiff(reader: Reader, directory: string, signal: AbortSignal, context?: number) {
  const [vcs, location] = await Promise.all([
    readJson(reader, "/api/vcs", {}, directory, signal),
    readBounded(reader, "/api/location", { "location[directory]": directory }, 1024 * 1024, signal)
      .then(({ bytes }) => JSON.parse(bytes.toString("utf8"))).catch(error => { throw error instanceof RemoteWorkspaceError ? error : new RemoteWorkspaceError("unavailable", 502) }),
  ])
  if (!vcs.data?.provider) throw new RemoteWorkspaceError("not_repository", 409)
  const root = location?.directory === directory ? location.project?.directory : undefined
  const prefix = typeof root === "string" ? locationPrefix(root, directory) : undefined
  // Unknown worktree root: paths cannot be brought back to the folder; never show it as clean.
  if (prefix === undefined) throw new RemoteWorkspaceError("ambiguous", 409)
  const value = await readJson(reader, "/api/vcs/diff", { mode: "working", ...(context ? { context: String(context) } : {}) }, directory, signal)
  if (!Array.isArray(value.data)) throw new RemoteWorkspaceError("unavailable", 502)
  const fold = prefix && /^[A-Za-z]:/.test(root!) ? (text: string) => text.toLowerCase() : (text: string) => text
  const rows: Array<NativeDiff & { path: string }> = []
  for (const entry of value.data as NativeDiff[]) {
    if (!entry || typeof entry.file !== "string" || !["added", "deleted", "modified"].includes(entry.status)) throw new RemoteWorkspaceError("unavailable", 502)
    const file = entry.file.replace(/\\/g, "/")
    // An untraversed folder containing the opened one leaves its whole state unknown.
    if (entry.more && prefix.startsWith(file.replace(/\/?$/, "/")) && file !== "") throw new RemoteWorkspaceError("ambiguous", 409)
    if (!fold(file).startsWith(fold(prefix))) continue
    const path = insideEntry(file.slice(prefix.length))
    if (!path) continue
    rows.push({ ...entry, path: entry.more ? `${path}/` : path })
  }
  return rows
}

/** Working-copy changes of the opened folder, in the local status shape (one unstaged section). */
export async function remoteGitStatus(reader: Reader, directory: string, signal: AbortSignal): Promise<WorktreeGitStatusEntry[]> {
  return (await workingDiff(reader, directory, signal)).map(row => ({
    path: row.path, originalPath: null, stagedStatus: null, stagedAdditions: 0, stagedDeletions: 0,
    unstagedStatus: row.status, unstagedAdditions: row.additions, unstagedDeletions: row.deletions,
  }))
}

/** Both sides of a whole-file patch; undefined when the patch cannot prove them. */
export function patchSides(patch: string): { before: string; after: string } | undefined {
  const lines = patch.split("\n")
  if (lines.at(-1) === "") lines.pop()
  const before: string[] = [], after: string[] = []
  let hunks = 0, last: "both" | "before" | "after" | undefined
  let noNewline = { before: false, after: false }
  let expected: { before: number; after: number } | undefined
  for (const line of lines) {
    const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (header) {
      if (++hunks > 1) return undefined
      // Full context starts at the first line of each side (0 for an empty side).
      if (!["0", "1"].includes(header[1]) || !["0", "1"].includes(header[3])) return undefined
      expected = { before: Number(header[2] ?? 1), after: Number(header[4] ?? 1) }
      continue
    }
    if (!hunks) continue
    if (line.startsWith("\\")) {
      if (last === "both" || last === "before") noNewline.before = true
      if (last === "both" || last === "after") noNewline.after = true
      continue
    }
    const text = line.slice(1)
    if (line.startsWith(" ")) { before.push(text); after.push(text); last = "both" }
    else if (line.startsWith("-")) { before.push(text); last = "before" }
    else if (line.startsWith("+")) { after.push(text); last = "after" }
    else return undefined
  }
  if (!hunks || !expected || before.length !== expected.before || after.length !== expected.after) return undefined
  const join = (side: string[], open: boolean) => side.length ? side.join("\n") + (open ? "" : "\n") : ""
  return { before: join(before, noNewline.before), after: join(after, noNewline.after) }
}

export async function remoteGitDiff(reader: Reader, directory: string, relativePath: unknown, signal: AbortSignal): Promise<WorktreeGitDiffResponse> {
  const path = remoteRelativePath(relativePath)
  const row = (await workingDiff(reader, directory, signal, FULL_CONTEXT)).find(entry => entry.path === path)
  if (!row) throw new RemoteWorkspaceError("not_found", 404)
  const base = { path, originalPath: null, scope: "unstaged" as const }
  if (/^Binary files /m.test(row.patch) || /^GIT binary patch/m.test(row.patch)) return { ...base, before: "", after: "", isBinary: true }
  // Empty or partial patches (budget, mode-only, untraversed folder) never pass for an unchanged file.
  const sides = row.more || !row.patch ? undefined : patchSides(row.patch)
  if (!sides) throw new RemoteWorkspaceError("ambiguous", 409)
  return { ...base, ...sides }
}
