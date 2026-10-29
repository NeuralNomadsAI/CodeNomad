// Paths are the server's, so their separator follows the given path rather
// than the browser's platform.

/** The folder `git clone` creates for a repository: its last path segment without `.git`. */
export function repositoryFolderName(repositoryUrl: string): string {
  const path = repositoryUrl.trim().replace(/[?#].*$/, "").replace(/[\\/]+$/, "")
  const name = path.split(/[\\/:]/).pop()?.replace(/\.git$/i, "") ?? ""
  return name === "." || name === ".." ? "" : name
}

/** The folder containing `path`, keeping a root's trailing separator (`D:\`, `/`). */
export function parentDirectory(path: string): string {
  const trimmed = path.replace(/(?<=[^\\/:])[\\/]+$/, "")
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  if (index < 0) return ""
  const parent = trimmed.slice(0, index)
  return parent === "" || parent.endsWith(":") ? trimmed.slice(0, index + 1) : parent
}

/** The suggested clone destination: the repository's folder inside `parent`. */
export function suggestCloneDestination(parent: string | undefined, repositoryUrl: string): string {
  const name = repositoryFolderName(repositoryUrl)
  if (!parent || !name) return ""
  const separator = parent.includes("\\") && !parent.includes("/") ? "\\" : "/"
  return /[\\/]$/.test(parent) ? `${parent}${name}` : `${parent}${separator}${name}`
}
