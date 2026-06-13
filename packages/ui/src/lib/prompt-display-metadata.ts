import type { Attachment, FileSource, TextSource } from "../types/attachment"

export type PromptDisplaySegmentKind = "inline" | "pasted"

export interface PromptDisplaySegment {
  kind: PromptDisplaySegmentKind
  text: string
}

export interface PromptDisplaySegmentMetadata {
  kind: PromptDisplaySegmentKind
  length: number
}

export interface PromptDisplayMetadata {
  segments: PromptDisplaySegmentMetadata[]
}

export interface PreparedPromptDisplayText {
  promptToSend: string
  displayMetadata?: PromptDisplayMetadata
}

const PASTED_PLACEHOLDER_REGEX = /\[\s*pasted\s*#\s*(\d+)\s*\]/gi

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n")
}

function hasPastedPlaceholders(text: string): boolean {
  PASTED_PLACEHOLDER_REGEX.lastIndex = 0
  return PASTED_PLACEHOLDER_REGEX.test(text)
}

function pushInlineSegment(segments: PromptDisplaySegment[], text: string): void {
  if (!text) return
  const previous = segments[segments.length - 1]
  if (previous && previous.kind === "inline") {
    previous.text += text
    return
  }
  segments.push({ kind: "inline", text })
}

function pushPastedSegment(segments: PromptDisplaySegment[], text: string): void {
  if (!text) return
  segments.push({ kind: "pasted", text })
}

function resolvePathMentions(prompt: string, attachments: Attachment[] = []): string {
  if (!prompt) {
    return prompt
  }

  const fileAttachments = new Set(
    attachments
      .filter((a): a is Attachment & { source: FileSource } => a.source.type === "file")
      .map((a) => a.source.path),
  )

  const pathAttachments = new Set(
    attachments
      .filter(
        (a): a is Attachment & { source: TextSource } =>
          a.source.type === "text" && typeof a.display === "string" && a.display.startsWith("path:"),
      )
      .map((a) => a.source.value),
  )

  let result = prompt

  result = result.replace(/@(\.\/)/g, "___ROOT___")
  result = result.replace(/@(\.)(?!\.)/g, "___ROOT_NOSLASH___")

  const allPaths = new Set<string>()
  for (const path of fileAttachments) {
    if (path && path !== "." && path !== "./") allPaths.add(path)
  }
  for (const path of pathAttachments) {
    if (path && path !== "." && path !== "./") allPaths.add(path)
  }

  for (const path of allPaths) {
    const withoutPrefix = path.startsWith("./") ? path.slice(2) : path
    const withPrefix = path.startsWith("./") ? path : `./${path}`
    result = result.replace(`@${withoutPrefix}`, withPrefix)
    result = result.replace(`@${withoutPrefix}/`, `${withPrefix}/`)
  }

  result = result.replace("___ROOT___", "./")
  result = result.replace("___ROOT_NOSLASH___", "./")

  return result
}

function createPastedLookup(attachments: Attachment[]): Map<string, string> {
  const lookup = new Map<string, string>()

  for (const attachment of attachments) {
    if (attachment?.source.type !== "text") continue
    if (typeof attachment.display !== "string") continue
    const match = attachment.display.match(/pasted #(\d+)/i)
    if (!match) continue
    if (!lookup.has(match[1])) {
      lookup.set(match[1], normalizeLineEndings(attachment.source.value))
    }
  }

  return lookup
}

export function resolvePastedPlaceholders(prompt: string, attachments: Attachment[] = []): string {
  const result = resolvePathMentions(prompt, attachments)
  if (!hasPastedPlaceholders(result)) {
    return result
  }

  const lookup = createPastedLookup(attachments)
  if (lookup.size === 0) {
    return result
  }

  return result.replace(PASTED_PLACEHOLDER_REGEX, (fullMatch, counter: string) => {
    const replacement = lookup.get(counter)
    return typeof replacement === "string" ? replacement : fullMatch
  })
}

export function preparePromptDisplayText(prompt: string, attachments: Attachment[] = []): PreparedPromptDisplayText {
  const resolvedBase = resolvePathMentions(prompt, attachments)
  if (!hasPastedPlaceholders(resolvedBase)) {
    return { promptToSend: resolvedBase }
  }

  const lookup = createPastedLookup(attachments)
  if (lookup.size === 0) {
    return { promptToSend: resolvedBase }
  }

  PASTED_PLACEHOLDER_REGEX.lastIndex = 0

  const segments: PromptDisplaySegment[] = []
  let lastIndex = 0
  let foundResolvablePlaceholder = false
  let failed = false

  for (const match of resolvedBase.matchAll(PASTED_PLACEHOLDER_REGEX)) {
    const start = match.index ?? 0
    const counter = match[1]
    const replacement = lookup.get(counter)
    if (typeof replacement !== "string") {
      failed = true
      break
    }

    pushInlineSegment(segments, resolvedBase.slice(lastIndex, start))
    pushPastedSegment(segments, replacement)
    foundResolvablePlaceholder = true
    lastIndex = start + match[0].length
  }

  if (failed || !foundResolvablePlaceholder) {
    return { promptToSend: resolvePastedPlaceholders(prompt, attachments) }
  }

  pushInlineSegment(segments, resolvedBase.slice(lastIndex))

  return {
    promptToSend: segments.map((segment) => segment.text).join(""),
    displayMetadata: {
      segments: segments.map((segment) => ({ kind: segment.kind, length: segment.text.length })),
    },
  }
}

export function splitPromptDisplaySections(
  text: string,
  metadata: PromptDisplayMetadata | undefined,
): PromptDisplaySegment[] | null {
  if (!metadata || !Array.isArray(metadata.segments) || metadata.segments.length === 0) {
    return null
  }

  const segments: PromptDisplaySegment[] = []
  let offset = 0

  for (const segment of metadata.segments) {
    if (!segment || typeof segment.length !== "number" || segment.length < 0) {
      return null
    }
    if (segment.kind !== "inline" && segment.kind !== "pasted") {
      return null
    }
    const nextOffset = offset + segment.length
    if (nextOffset > text.length) {
      return null
    }
    const nextText = text.slice(offset, nextOffset)
    if (segment.kind === "inline") {
      pushInlineSegment(segments, nextText)
    } else {
      pushPastedSegment(segments, nextText)
    }
    offset = nextOffset
  }

  if (offset !== text.length) {
    return null
  }

  return segments
}
