import type { FileSystemEntry, FileSystemListResponse } from "../api-types"
import { z } from "zod"

const MAX_ENTRIES = 2_000
const RemotePath = z.string().max(8192)
const Listing = z.object({
  entries: z.array(z.object({ name: z.string().max(1024), path: RemotePath, absolutePath: RemotePath.optional(), type: z.enum(["directory", "file"]) })).max(MAX_ENTRIES),
  metadata: z.object({ scope: z.enum(["restricted", "unrestricted"]), currentPath: RemotePath, parentPath: RemotePath.optional(),
    rootPath: RemotePath, homePath: RemotePath, displayPath: RemotePath, pathKind: z.enum(["relative", "absolute", "drives"]) }),
})

function joinRemote(root: string, relative: string): string {
  if (relative === "." || relative === "") return root
  const separator = /^[A-Za-z]:\\/.test(root) && !root.includes("/") ? "\\" : "/"
  const base = root.replace(/[\\/]+$/, "")
  return `${base}${separator}${relative.split("/").join(separator)}`
}

/** The remote's folder listing with absolute paths only (a restricted root answers relative ones),
 * folders only, in the shape the folder browser reads. */
export function relayedFolderListing(input: unknown): FileSystemListResponse {
  const value = Listing.parse(input)
  const metadata = value?.metadata
  if (!metadata || typeof metadata.currentPath !== "string" || !Array.isArray(value.entries)) throw new Error("Invalid remote folder listing")
  const relative = metadata.pathKind === "relative"
  const currentPath = relative ? (typeof metadata.displayPath === "string" ? metadata.displayPath : joinRemote(metadata.rootPath, metadata.currentPath)) : metadata.currentPath
  const parentPath = metadata.parentPath === undefined ? undefined : relative ? joinRemote(metadata.rootPath, metadata.parentPath) : metadata.parentPath
  const entries: FileSystemEntry[] = []
  for (const entry of value.entries) {
    if (entries.length >= MAX_ENTRIES) break
    if (entry?.type !== "directory" || typeof entry.name !== "string") continue
    const absolute = typeof entry.absolutePath === "string" ? entry.absolutePath : relative ? joinRemote(metadata.rootPath, entry.path) : entry.path
    if (typeof absolute !== "string") continue
    entries.push({ name: entry.name, path: absolute, absolutePath: absolute, type: "directory" })
  }
  return {
    entries,
    metadata: { ...metadata, currentPath, ...(parentPath === undefined ? { parentPath: undefined } : { parentPath }), displayPath: currentPath, pathKind: metadata.pathKind === "drives" ? "drives" : "absolute" },
  }
}
