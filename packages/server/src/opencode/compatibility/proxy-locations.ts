import path from "node:path"
import type { LocationRef } from "@opencode/client"
import { readLocationRef } from "./location"

export interface RequestLocations {
  directories: string[]
  locations: LocationRef[]
  invalid: boolean
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && !Buffer.isBuffer(value)
}

// Public requests are directory-scoped. Reject obsolete selectors explicitly so
// the generated client's field selection cannot silently discard authority.
export function readRequestLocations(url: URL, body: unknown, defaultDirectory: string): RequestLocations {
  const result: RequestLocations = { directories: [], locations: [], invalid: false }
  const add = (directory: unknown, workspaceID?: unknown) => {
    try {
      const ref = readLocationRef({ directory, workspaceID })
      if (workspaceID !== undefined) throw new Error("Unsupported workspace selector")
      result.directories.push(ref.directory)
      result.locations.push(ref)
    } catch { result.invalid = true }
  }
  for (const key of ["directory", "location[directory]"]) {
    if (url.searchParams.getAll(key).length > 1) result.invalid = true
  }
  if (["workspace", "location[workspace]", "workspaceID", "location[workspaceID]"].some(key => url.searchParams.has(key))) result.invalid = true
  for (const directoryKey of ["directory", "location[directory]"]) {
    const directory = url.searchParams.get(directoryKey) ?? undefined
    if (directory !== undefined) add(directory)
  }
  if (object(body)) {
    if ("workspace" in body) result.invalid = true
    if ("directory" in body || "workspaceID" in body) add(body.directory ?? defaultDirectory, body.workspaceID)
    if (body.location !== undefined && body.location !== null) {
      if (!object(body.location) || "workspace" in body.location) result.invalid = true
      else add(body.location.directory ?? defaultDirectory, body.location.workspaceID)
    }
  }
  return result
}

// Preserve the export/history identities; never rewrite every historical
// location to the import destination. Each is independently authorized by the
// caller and subsequently directory-translated at the existing proxy boundary.
export function prepareLocationImport(body: unknown, directory: string): RequestLocations & { body: unknown } {
  const result: RequestLocations & { body: unknown } = { body, directories: [], locations: [], invalid: false }
  if (!object(body)) return { ...result, invalid: true }
  const addLocation = (owner: Record<string, unknown>, key: string) => {
    const input = owner[key] ?? { directory }
    if (!object(input) || "workspace" in input) { result.invalid = true; return }
    try {
      const location = readLocationRef({ ...input, directory: input.directory ?? directory })
      if (location.workspaceID !== undefined) throw new Error("Unsupported workspace selector")
      owner[key] = location
      result.directories.push(location.directory)
      result.locations.push(location)
    } catch { result.invalid = true }
  }
  // A copy keeps failed authorization from mutating the incoming request.
  const input = { ...body }
  result.body = input
  addLocation(input, "location")
  if (object(input.info)) { input.info = { ...input.info }; addLocation(input.info as Record<string, unknown>, "location") }
  if (Array.isArray(input.messages)) input.messages = input.messages.map((message) => {
    if (!object(message) || message.type !== "location-switched") return message
    const next = { ...message }
    addLocation(next, "location")
    if (object(next.previous)) { next.previous = { ...next.previous }; addLocation(next.previous as Record<string, unknown>, "location") }
    return next
  })
  return result
}

export interface SessionListScope {
  directory?: string
  project?: string
  subpath?: string
}

export function decodeSessionListScope(cursor: string): SessionListScope | null {
  if (!cursor || cursor.length > 65_536 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return null
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
    if (!object(value) || value.workspaceID !== undefined || value.workspace !== undefined) return null
    const anchor = value.anchor
    if (!object(anchor) || typeof anchor.id !== "string" || !anchor.id
      || typeof anchor.time !== "number" || !Number.isFinite(anchor.time)
      || (anchor.direction !== "previous" && anchor.direction !== "next")) return null
    if (value.search !== undefined && typeof value.search !== "string") return null
    if (value.order !== undefined && value.order !== "asc" && value.order !== "desc") return null
    if (value.parentID !== undefined && value.parentID !== null && typeof value.parentID !== "string") return null
    if (typeof value.directory === "string" && value.directory.trim() && value.project === undefined && value.subpath === undefined) {
      return { directory: value.directory }
    }
    if (typeof value.project === "string" && value.project.trim() && value.directory === undefined) {
      if (value.subpath === undefined) return { project: value.project }
      if (typeof value.subpath === "string" && !path.posix.isAbsolute(value.subpath)
        && !path.win32.isAbsolute(value.subpath) && !value.subpath.split(/[\\/]/).includes("..")) {
        return { project: value.project, subpath: value.subpath }
      }
    }
    // Workspace-only/unscoped tokens cannot prove directory authority.
    return null
  } catch { return null }
}
