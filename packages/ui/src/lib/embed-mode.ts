/**
 * The single-project view a desktop host shows in a remote CodeNomad project tab.
 * The host loads `/?codenomadEmbed=project[&folder=…]`; the embedded page keeps
 * the folder it shows in its address and the project name in its document title.
 * A server that does not know the parameter shows its full interface instead.
 */
export const EMBED_PARAM = "codenomadEmbed"
export const EMBED_PROJECT = "project"
export const EMBED_FOLDER_PARAM = "folder"
const MAX_FOLDER_LENGTH = 4096
const MAX_TITLE_LENGTH = 256

export interface EmbeddedProjectTarget {
  folder?: string
}

function readFolder(params: URLSearchParams): string | undefined {
  const folder = params.get(EMBED_FOLDER_PARAM)?.trim()
  return folder && folder.length <= MAX_FOLDER_LENGTH ? folder : undefined
}

export function readEmbeddedProject(search: string): EmbeddedProjectTarget | null {
  const params = new URLSearchParams(search)
  if (params.get(EMBED_PARAM) !== EMBED_PROJECT) return null
  const folder = readFolder(params)
  return folder ? { folder } : {}
}

/** Read once: the embedded page never leaves this mode. */
export const embeddedProject: EmbeddedProjectTarget | null =
  typeof window === "undefined" ? null : readEmbeddedProject(window.location.search)

export const isEmbeddedProjectView = () => embeddedProject !== null

/** The entry the host loads for a server, at its root. */
export function embeddedProjectUrl(baseUrl: string, folder?: string): string {
  const url = new URL(baseUrl)
  url.pathname = "/"
  url.search = ""
  url.hash = ""
  url.searchParams.set(EMBED_PARAM, EMBED_PROJECT)
  if (folder) url.searchParams.set(EMBED_FOLDER_PARAM, folder)
  return url.toString()
}

/** The embedded page records what it shows; replacing the entry keeps history and reloads on this project. */
export function publishEmbeddedProject(folder: string, title: string): void {
  if (typeof window === "undefined") return
  const url = new URL(window.location.href)
  if (url.searchParams.get(EMBED_FOLDER_PARAM) !== folder) {
    url.searchParams.set(EMBED_PARAM, EMBED_PROJECT)
    url.searchParams.set(EMBED_FOLDER_PARAM, folder)
    window.history.replaceState(window.history.state, "", url)
  }
  // The host reads the address when the title changes: set it last.
  document.title = title
}

export interface EmbeddedProjectReport {
  folder: string
  title: string
}

/**
 * What a host accepts from an embedded page's title change: only an address on
 * the server's origin that names a folder. An older server keeps the bare entry
 * address, so its own title (its brand) never relabels the tab.
 */
export function readEmbeddedProjectReport(url: string, title: string, origin: string): EmbeddedProjectReport | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.origin !== origin || parsed.searchParams.get(EMBED_PARAM) !== EMBED_PROJECT) return null
  const folder = readFolder(parsed.searchParams)
  const name = title.trim().slice(0, MAX_TITLE_LENGTH)
  return folder && name ? { folder, title: name } : null
}
