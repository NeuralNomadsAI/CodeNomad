// prototype-1236: folder browsing on an explicit OpenCode server, through its single shared connection.
import type { FileSystemEntry, FileSystemListResponse } from "../../api-types"

/** Native `file.list`: entries are relative to the location answered (the server's default one). */
type NativeList = (input?: { path?: string; location?: { directory: string } }, options?: { signal?: AbortSignal }) => Promise<{
  location: { directory: string }
  data: ReadonlyArray<{ path: string; type: "file" | "directory" }>
}>

const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/])/
const MAX_PATH = 4_096
const MAX_ENTRIES = 2_000

export class ServerFolderPathError extends Error {
  constructor() { super("invalid_path"); this.name = "ServerFolderPathError" }
}

/** An absolute folder on the server, or undefined for its default location. */
export function parseServerFolderPath(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined
  if (typeof value !== "string" || value.length > MAX_PATH || value.includes("\0") || !ABSOLUTE.test(value)) throw new ServerFolderPathError()
  return value
}

function separatorOf(path: string): "/" | "\\" {
  return /^[A-Za-z]:/.test(path) && !path.includes("/") ? "\\" : "/"
}

function trimTrailing(path: string): string {
  const root = /^(?:[A-Za-z]:[\\/]|\/)$/.test(path)
  return root ? path : path.replace(/[\\/]+$/, "")
}

function parentOf(path: string): string | undefined {
  const current = trimTrailing(path), separator = separatorOf(current)
  const index = Math.max(current.lastIndexOf("/"), current.lastIndexOf("\\"))
  if (index < 0 || current === "/" || /^[A-Za-z]:[\\/]$/.test(current)) return undefined
  const parent = current.slice(0, index)
  return parent === "" ? "/" : /^[A-Za-z]:$/.test(parent) ? `${parent}${separator}` : parent
}

function rootOf(path: string): string {
  const drive = path.match(/^([A-Za-z]:)[\\/]/)
  return drive ? `${drive[1]}${separatorOf(path)}` : "/"
}

function join(base: string, name: string): string {
  const separator = separatorOf(base)
  return /[\\/]$/.test(base) ? `${base}${name}` : `${base}${separator}${name}`
}

/** Lists only folders, in the listing shape the folder browser already reads. */
export async function listServerFolders(list: NativeList, path: string | undefined, signal?: AbortSignal): Promise<FileSystemListResponse> {
  // An absolute path is read from the default location; a server refusing paths outside it
  // is asked for that folder as its own location instead.
  let answer: Awaited<ReturnType<NativeList>>
  try { answer = await list(path === undefined ? undefined : { path }, { signal }) }
  catch (error) {
    if (path === undefined || signal?.aborted) throw error
    answer = await list({ location: { directory: path } }, { signal })
  }
  const home = answer.location.directory
  const current = trimTrailing(path ?? home)
  const seen = new Set<string>()
  const entries: FileSystemEntry[] = []
  for (const entry of answer.data) {
    if (entry.type !== "directory" || entries.length >= MAX_ENTRIES) continue
    const name = entry.path.split(/[\\/]/).filter(Boolean).at(-1)
    if (!name || name === "." || name === ".." || seen.has(name)) continue
    seen.add(name)
    const absolute = join(current, name)
    entries.push({ name, path: absolute, absolutePath: absolute, type: "directory" })
  }
  const parentPath = parentOf(current)
  return {
    entries,
    metadata: {
      scope: "unrestricted", currentPath: current, ...(parentPath ? { parentPath } : {}),
      rootPath: rootOf(current), homePath: home, displayPath: current, pathKind: "absolute",
    },
  }
}
