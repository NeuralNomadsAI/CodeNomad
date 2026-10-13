// Dependency-free: shared by the native plugin, HTTP schemas and the renderer.

/** Short human label for a Mission; the objective remains the authoritative text. */
export const MISSION_TITLE_MAX = 60
export const MISSION_TITLE_PATTERN = /^[^\r\n]*$/

/** Trimmed single-line 1–60 characters, otherwise undefined. */
export function parseMissionTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const title = value.trim()
  return title.length >= 1 && title.length <= MISSION_TITLE_MAX && MISSION_TITLE_PATTERN.test(title) ? title : undefined
}

/** First sentence or clause of the first non-empty line, bounded at a word. */
export function deriveMissionTitle(text: string): string {
  const line = text.split(/\r?\n/).map(item => item.replace(/\s+/g, " ").trim()).find(Boolean) ?? ""
  const clause = line.split(/(?<=[.!?;:])\s/)[0]!.replace(/[.;:]$/, "").trim()
  if (clause.length <= MISSION_TITLE_MAX) return clause
  const cut = clause.slice(0, MISSION_TITLE_MAX - 1)
  const space = cut.lastIndexOf(" ")
  return `${(space > MISSION_TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

export function missionCoordinatorTitle(title: string | undefined, objective: string): string {
  return `Mission · ${title ?? (deriveMissionTitle(objective) || "untitled")}`.slice(0, 160)
}
