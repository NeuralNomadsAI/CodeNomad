/** Classification and lexical resolution for agent-reply links that point at
 * files inside the session's worktree. Pure helpers only: the store-backed
 * routing lives in components/markdown-session-links.ts. */

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/
const WINDOWS_ROOT = /^[A-Za-z]:\//

/** A project-file link candidate's normalized path, or undefined when the href
 * cannot point at a workspace file (URL schemes, scheme-relative and UNC
 * values, pure fragments, empty). */
export function projectLinkPath(href: string): string | undefined {
  const trimmed = href.trim()
  if (!trimmed || trimmed.startsWith("#")) return undefined
  const fragment = trimmed.indexOf("#")
  const withoutFragment = fragment >= 0 ? trimmed.slice(0, fragment) : trimmed
  // A Windows drive letter (`C:\…`, `C:/…`) is a path, not a scheme.
  if (!WINDOWS_DRIVE.test(withoutFragment) && SCHEME.test(withoutFragment)) return undefined
  let path = withoutFragment.replace(/\\/g, "/")
  if (path.startsWith("//")) return undefined
  try {
    const decoded = decodeURIComponent(path)
    if (decoded !== path) path = decoded
  } catch {
    // A literal percent sign is a legal file name character; keep it.
  }
  // Decoding can reveal a scheme, a scheme-relative or a UNC value the literal
  // form hid; such a value is a URL, not a workspace file path.
  if (path.startsWith("//")) return undefined
  if (!WINDOWS_DRIVE.test(path) && SCHEME.test(path)) return undefined
  path = path.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "")
  return path || undefined
}

const normalizeSegments = (path: string, rooted: boolean): string => {
  const stack: string[] = []
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue
    if (segment === "..") {
      if (stack.length) stack.pop()
      continue
    }
    stack.push(segment)
  }
  return (rooted ? "/" : "") + stack.join("/")
}

const normalizeBase = (directory: string): string => directory.replace(/\\/g, "/").replace(/\/+$/, "")

/** The worktree-relative path (forward slashes, no leading `./`) when the href
 * resolves inside `baseDirectory`, else undefined. Lexical resolution only;
 * `..` never fabricates containment because it is re-checked against the base. */
export function resolveProjectLinkPath(href: string, baseDirectory: string): string | undefined {
  const base = normalizeBase(baseDirectory)
  if (!base) return undefined
  const path = projectLinkPath(href)
  if (path === undefined) return undefined
  const absolute = path.startsWith("/") || WINDOWS_ROOT.test(path)
  const resolved = absolute
    ? normalizeSegments(path, path.startsWith("/"))
    : normalizeSegments(`${base}/${path}`, base.startsWith("/"))
  const comparable = WINDOWS_ROOT.test(base)
    ? (value: string) => value.toLowerCase()
    : (value: string) => value
  const resolvedKey = comparable(resolved)
  const baseKey = comparable(base)
  // The root itself is not a file target.
  if (resolvedKey === baseKey) return undefined
  if (!resolvedKey.startsWith(`${baseKey}/`)) return undefined
  return resolved.slice(base.length + 1)
}
