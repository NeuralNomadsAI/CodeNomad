import type { LocationRef, OpenCodeClient } from "@opencode/client"
import type { ContractProfile } from "./runtime"
import { readLocationRef } from "../session-pruning/location"
export { readLocationRef, sameLocation } from "../session-pruning/location"

// An explicit CodeNomad context channel survives the generated modern client's
// field selection. Never forward this header to OpenCode unchanged. The guarded
// proxy must authorize its complete location before transport serialization.
export const LOCATION_CONTEXT_HEADER = "x-codenomad-location"

export function locationRequestOptions(location: LocationRef, options?: { includeDirectory?: boolean }): { headers: Record<string, string> } | undefined {
  const resolved = readLocationRef(location)
  return resolved.workspaceID === undefined && !options?.includeDirectory ? undefined : {
    headers: { [LOCATION_CONTEXT_HEADER]: encodeURIComponent(JSON.stringify(resolved)) },
  }
}

export function readLocationContext(value: string | string[] | undefined, profile: ContractProfile): LocationRef | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.length > 16_384) throw new Error("Invalid location context")
  const input: unknown = JSON.parse(decodeURIComponent(value))
  if (!input || typeof input !== "object" || Object.keys(input).some(key => key !== "directory" && key !== "workspaceID")) {
    throw new Error("Invalid location context")
  }
  const location = readLocationRef(input)
  if (location.workspaceID !== undefined && profile !== "legacy") throw new Error("Unsupported workspace selector")
  return location
}

export async function moveSessionToLocation(client: OpenCodeClient, sessionID: string, location: LocationRef): Promise<void> {
  await client.session.move({ sessionID, directory: location.directory }, locationRequestOptions(location))
}

// The selected transport calls this AFTER authorization. Only the explicitly
// supported wire slots are adapted; this is not a general header-to-body merge.
export function applyLocationContext(url: URL, method: string, body: unknown, headers: Headers, profile: ContractProfile): unknown {
  const location = readLocationContext(headers.get(LOCATION_CONTEXT_HEADER) ?? undefined, profile)
  headers.delete(LOCATION_CONTEXT_HEADER)
  if (!location) return body
  const input = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : undefined
  if (method === "POST" && url.pathname === "/api/worktree/refresh") {
    if (profile === "modern") return body
    url.searchParams.set("location[directory]", location.directory)
    if (location.workspaceID !== undefined) url.searchParams.set("location[workspace]", location.workspaceID)
    return undefined
  }
  const assertDirectory = (directory: unknown) => {
    if (directory !== location.directory) throw new Error("Location context does not match request")
  }
  if (method === "POST" && /^\/api\/session\/[^/]+\/move\/?$/.test(url.pathname)) {
    assertDirectory(input?.directory)
    if (input?.workspaceID !== undefined && input.workspaceID !== location.workspaceID) throw new Error("Conflicting workspace selector")
    return { ...input, workspaceID: location.workspaceID }
  }
  if (method === "POST" && /^\/api\/(?:experimental\/)?session(?:\/import)?\/?$/.test(url.pathname)) {
    const destination = readLocationRef(input?.location)
    assertDirectory(destination.directory)
    if (destination.workspaceID !== undefined && destination.workspaceID !== location.workspaceID) throw new Error("Conflicting workspace selector")
    return { ...input, location: { ...destination, workspaceID: location.workspaceID } }
  }
  if (/^\/api\/session\/global\/form(?:\/[^/]+(?:\/(?:reply|cancel|state))?)?\/?$/.test(url.pathname)) {
    assertDirectory(decodeURIComponent(headers.get("x-opencode-directory") ?? ""))
    if (location.workspaceID !== undefined) headers.set("x-opencode-workspace", location.workspaceID)
    return body
  }
  if (method === "GET" && /^\/api\/session\/?$/.test(url.pathname)) {
    // The cursor is the complete native query, not a location selector to amend.
    if (url.searchParams.has("cursor")) throw new Error("Cursor already carries session list scope")
    assertDirectory(url.searchParams.get("directory"))
    if (url.searchParams.has("workspace")) throw new Error("Conflicting workspace selector")
    if (location.workspaceID !== undefined) url.searchParams.set("workspace", location.workspaceID)
    return body
  }
  if (/^\/api\/credential\/[^/]+(?:\/activate)?\/?$/.test(url.pathname)) {
    // Modern credential mutations are global; legacy invalidation is scoped.
    // The generated modern client has no location query to preserve for us.
    if (profile !== "legacy") return body
    if (url.searchParams.has("location[directory]")) assertDirectory(url.searchParams.get("location[directory]"))
    url.searchParams.set("location[directory]", location.directory)
  }
  const directory = url.searchParams.get("location[directory]")
  assertDirectory(directory)
  if (url.searchParams.has("location[workspace]")) throw new Error("Conflicting workspace selector")
  if (location.workspaceID !== undefined) url.searchParams.set("location[workspace]", location.workspaceID)
  return body
}
