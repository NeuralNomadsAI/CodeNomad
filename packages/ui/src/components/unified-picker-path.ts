export function splitDisplayPath(path: string) {
  const isDirectory = path.endsWith("/")
  const parts = path.split("/").filter(Boolean)
  const folders = parts.slice(0, -1)
  return {
    name: parts.length > 0 ? `${parts[parts.length - 1]}${isDirectory ? "/" : ""}` : path,
    parent: folders[folders.length - 1] ?? "",
    directory: folders.join("/"),
  }
}
