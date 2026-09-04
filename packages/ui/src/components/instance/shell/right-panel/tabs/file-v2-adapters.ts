import type { FileSystemEntry } from "@opencode-ai/client"
import type { FileBrowserEntry } from "./FilesTab"

export function adaptFileSystemEntries(entries: FileSystemEntry[]): FileBrowserEntry[] {
  return entries.map((entry) => {
    const path = entry.path.replace(/\\+/g, "/").replace(/\/+$/, "")
    return { ...entry, path, name: path.split("/").pop() || path }
  })
}

export function decodeFileContent(content: Uint8Array): string {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(content)
  if (text.includes("\0")) throw new Error("Binary file cannot be displayed")
  return text
}
