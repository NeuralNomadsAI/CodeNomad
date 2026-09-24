import type { LocationRef, OpenCodeClient } from "@opencode/client"
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

export function readLocationContext(value: string | string[] | undefined): LocationRef | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.length > 16_384) throw new Error("Invalid location context")
  const input: unknown = JSON.parse(decodeURIComponent(value))
  if (!input || typeof input !== "object" || Object.keys(input).some(key => key !== "directory" && key !== "workspaceID")) {
    throw new Error("Invalid location context")
  }
  const location = readLocationRef(input)
  if (location.workspaceID !== undefined) throw new Error("Unsupported workspace selector")
  return location
}

export async function moveSessionToLocation(client: OpenCodeClient, sessionID: string, location: LocationRef): Promise<void> {
  await client.session.move({ sessionID, directory: location.directory }, locationRequestOptions(location))
}

// The transport calls this AFTER authorization. Validate the directory context
// against its public wire slot without injecting obsolete identity selectors.
export function applyLocationContext(url: URL, method: string, body: unknown, headers: Headers): unknown {
  const location = readLocationContext(headers.get(LOCATION_CONTEXT_HEADER) ?? undefined)
  headers.delete(LOCATION_CONTEXT_HEADER)
  if (!location) return body
  if (["workspace", "location[workspace]", "workspaceID", "location[workspaceID]"].some(key => url.searchParams.has(key))
    || headers.has("x-opencode-workspace")) throw new Error("Unsupported workspace selector")
  const input = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : undefined
  if ((url.pathname === "/api/worktree" && ["GET", "POST", "DELETE"].includes(method))
    || (method === "POST" && url.pathname === "/api/worktree/refresh")) {
    return body
  }
  const assertDirectory = (directory: unknown) => {
    if (directory !== location.directory) throw new Error("Location context does not match request")
  }
  if (method === "POST" && /^\/api\/session\/[^/]+\/move\/?$/.test(url.pathname)) {
    assertDirectory(input?.directory)
    if (input?.workspaceID !== undefined) throw new Error("Unsupported workspace selector")
    return body
  }
  if (method === "POST" && /^\/api\/(?:session|experimental\/session\/import)\/?$/.test(url.pathname)) {
    const destination = readLocationRef(input?.location)
    assertDirectory(destination.directory)
    if (destination.workspaceID !== undefined) throw new Error("Unsupported workspace selector")
    return body
  }
  if (/^\/api\/session\/global\/form(?:\/[^/]+(?:\/reply)?)?\/?$/.test(url.pathname)) {
    assertDirectory(decodeURIComponent(headers.get("x-opencode-directory") ?? ""))
    return body
  }
  if (method === "GET" && /^\/api\/session\/?$/.test(url.pathname)) {
    // The cursor is the complete native query, not a location selector to amend.
    if (url.searchParams.has("cursor")) throw new Error("Cursor already carries session list scope")
    assertDirectory(url.searchParams.get("directory"))
    return body
  }
  if (/^\/api\/credential\/[^/]+(?:\/activate)?\/?$/.test(url.pathname)) {
    // Credential mutations are global; context must not create location scope.
    return body
  }
  const sessionRoute = url.pathname.replace(/\/+$/, "").match(/^\/api\/(?:experimental\/)?session\/([^/]+)(?:\/.*)?$/)
  if (sessionRoute && sessionRoute[1] !== "active" && sessionRoute[1] !== "import") {
    // A specific session's routes carry authority in the session identity,
    // already ownership-checked by the proxy via session.get (which excludes
    // the active/import pseudo-identities the same way). These native routes
    // accept no location slot, so an ambient location header must not fail
    // them here (for example instructions entries on every send). This check
    // stays after the move/create/import/form/list handlers above, which do
    // validate their own location slots.
    return body
  }
  const directory = url.searchParams.get("location[directory]")
  assertDirectory(directory)
  return body
}
