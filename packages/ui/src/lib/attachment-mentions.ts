const MAX_MENTION_CANDIDATE_LENGTH = 4096

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function addCandidate(candidates: string[], value: unknown): void {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_MENTION_CANDIDATE_LENGTH) return
  if (!candidates.includes(value)) candidates.push(value)
}

export function getAttachmentPromptMentionCandidates(value: unknown): string[] {
  if (!isRecord(value)) return []

  const candidates: string[] = []
  if (typeof value.display === "string" && value.display.startsWith("@")) {
    addCandidate(candidates, value.display.slice(1))
  }

  const source = value.source
  if (!isRecord(source)) return candidates

  if (source.type === "file") {
    addCandidate(candidates, source.path)
    addCandidate(candidates, value.filename)

    if (source.mime === "inode/directory" && typeof source.path === "string") {
      const trimmed = source.path.replace(/\/+$/, "")
      if (trimmed === "" || trimmed === ".") {
        addCandidate(candidates, "./")
      } else {
        addCandidate(candidates, `${trimmed}/`)
        addCandidate(candidates, `${trimmed.replace(/^\.\//, "")}/`)
      }
    }
  } else if (source.type === "agent") {
    addCandidate(candidates, source.name)
    addCandidate(candidates, value.filename)
  } else if (
    source.type === "text" &&
    typeof source.value === "string" &&
    value.display === `path: ${source.value}`
  ) {
    addCandidate(candidates, source.value)
  }

  return candidates
}

export function createPromptMentionRegex(
  candidate: string,
  options: { global?: boolean } = {},
): RegExp {
  // Picker paths are inserted literally, including spaces; escaping is only for regex matching.
  return new RegExp(`@${escapeRegExp(candidate)}(?=\\s|$)`, options.global ? "gi" : "i")
}
