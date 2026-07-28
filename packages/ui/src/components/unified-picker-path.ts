export function splitDisplayPath(path: string) {
  const isDirectory = path.endsWith("/")
  const parts = path.split("/").filter(Boolean)
  const folders = parts.slice(0, -1)
  return {
    name: parts.length > 0 ? `${parts.at(-1)}${isDirectory ? "/" : ""}` : path,
    start: folders[0] ?? "",
    parent: folders.length > 1 ? folders.at(-1) ?? "" : "",
    hasMiddle: folders.length > 2,
  }
}
