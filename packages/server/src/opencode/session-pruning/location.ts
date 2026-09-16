import type { LocationRef } from "@opencode/client"

// Keep identity primitives inside the standalone plugin's package boundary.
// The HTTP compatibility adapter reuses these without making the plugin depend on it.
export function readLocationRef(value: unknown): LocationRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid location")
  const input = value as Record<string, unknown>
  if (typeof input.directory !== "string" || !input.directory.trim() || input.directory.includes("\0")
    || (input.workspaceID !== undefined && (typeof input.workspaceID !== "string"
      || !input.workspaceID.trim() || input.workspaceID.includes("\0")))) throw new Error("Invalid location")
  return { directory: input.directory, ...(input.workspaceID === undefined ? {} : { workspaceID: input.workspaceID }) }
}

export function sameLocation(left: LocationRef, right: LocationRef): boolean {
  return left.directory === right.directory && left.workspaceID === right.workspaceID
}
