import type { Attachment, FileSource, TextSource } from "../types/attachment"
import { createAttachmentPlaceholderRegex } from "./attachment-placeholders"

export type PromptDisplaySegmentKind = "inline" | "pasted"

export interface PromptDisplaySegment {
  kind: PromptDisplaySegmentKind
  text: string
  /**
   * Pasted text inside a fenced code block: `text` is the code between the
   * block's fences, which renders as one literal code block (`formatFencedCode`
   * fences each displayed window of it), and the block's opening fence.
   */
  codeFence?: PromptDisplayCodeFence
}

export interface PromptDisplayCodeFence {
  /** The opening fence run, e.g. "```" or "~~~~". */
  marker: string
  info: string
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

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n")
}

function hasPastedPlaceholders(text: string): boolean {
  return createAttachmentPlaceholderRegex("pasted").test(text)
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

  result = result.replace(/@(\.\/)/g, "./")
  result = result.replace(/@(\.)(?!\.)/g, "./")

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

  return result.replace(createAttachmentPlaceholderRegex("pasted"), (fullMatch, counter: string) => {
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

  const segments: PromptDisplaySegment[] = []
  let lastIndex = 0
  let foundResolvablePlaceholder = false
  let failed = false

  for (const match of resolvedBase.matchAll(createAttachmentPlaceholderRegex("pasted"))) {
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

  return groupFencedPastedSegments(segments)
}

interface FencedPasteRegion {
  start: number
  end: number
  /** The opening fence run (e.g. "```") and its info string. */
  marker: string
  info: string
  contentStart: number
  contentEnd: number
}

// CommonMark fence lines: up to three spaces of indentation, then at least three
// backticks or tildes; a backtick opener's info string holds no backtick, and a
// closer is followed only by spaces or tabs.
const FENCE_LINE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/
const CLOSING_FENCE_SUFFIX = /^[ \t]*$/

function readFenceLine(line: string): { marker: string; length: number; info: string } | null {
  const match = FENCE_LINE_PATTERN.exec(line.endsWith("\r") ? line.slice(0, -1) : line)
  if (!match) return null
  return { marker: match[1][0], length: match[1].length, info: match[2] }
}

/**
 * Fences a displayed window of grouped code with a fence longer than any run of
 * its marker in that window, so pasted fence lines stay literal code. Callers
 * bound the code first and fence only the window, so a generated fence is never
 * cut by the display bound. The sent text is unchanged.
 */
export function formatFencedCode({ marker, info }: PromptDisplayCodeFence, code: string): string {
  const char = marker[0]
  let longestRun = 0
  let run = 0
  for (let index = 0; index < code.length; index += 1) {
    run = code[index] === char ? run + 1 : 0
    if (run > longestRun) longestRun = run
  }
  const fence = char.repeat(Math.max(marker.length, longestRun + 1))
  return `${fence}${info}\n${code}\n${fence}`
}

/**
 * Finds the fenced code blocks of the joined message text that contain pasted
 * text. Lines touching pasted text are code content, never fence lines, so a
 * pasted segment outside a fence keeps its own rendering and the fences of
 * pasted text inside one never split the block.
 */
function findFencedPasteRegions(text: string, pastedRanges: Array<{ start: number; end: number }>): FencedPasteRegion[] {
  const regions: FencedPasteRegion[] = []
  let open: { marker: string; info: string; start: number; contentStart: number; hasPaste: boolean } | null = null
  let rangeIndex = 0
  let lineStart = 0

  while (lineStart <= text.length) {
    let lineEnd = text.indexOf("\n", lineStart)
    if (lineEnd < 0) lineEnd = text.length
    let touchesPaste = false
    while (rangeIndex < pastedRanges.length && pastedRanges[rangeIndex].start < lineEnd) {
      touchesPaste = true
      const rangeEnd = pastedRanges[rangeIndex].end
      rangeIndex += 1
      if (rangeEnd > lineEnd) {
        // A paste ending in a line break ends its line; the next line is untouched.
        lineEnd = text[rangeEnd - 1] === "\n" ? rangeEnd - 1 : text.indexOf("\n", rangeEnd)
        if (lineEnd < 0) lineEnd = text.length
      }
    }

    if (touchesPaste) {
      if (open) open.hasPaste = true
    } else {
      const fence = readFenceLine(text.slice(lineStart, lineEnd))
      if (!open) {
        if (fence && !(fence.marker === "`" && fence.info.includes("`"))) {
          open = { marker: fence.marker.repeat(fence.length), info: fence.info, start: lineStart, contentStart: Math.min(lineEnd + 1, text.length), hasPaste: false }
        }
      } else if (fence && fence.marker === open.marker[0] && fence.length >= open.marker.length && CLOSING_FENCE_SUFFIX.test(fence.info)) {
        if (open.hasPaste) {
          // The line break before the closer, LF or CRLF, is not code.
          const contentEnd = lineStart - (text[lineStart - 2] === "\r" ? 2 : 1)
          regions.push({ start: open.start, end: lineEnd, marker: open.marker, info: open.info,
            contentStart: open.contentStart, contentEnd: Math.max(open.contentStart, contentEnd) })
        }
        open = null
      }
    }

    if (lineEnd >= text.length) break
    lineStart = lineEnd + 1
  }

  // An unclosed fence runs to the end of the message.
  if (open?.hasPaste) {
    regions.push({ start: open.start, end: text.length, marker: open.marker, info: open.info,
      contentStart: open.contentStart, contentEnd: text.length })
  }
  return regions
}

/**
 * Renders every fenced code block holding pasted text as one pasted section, so
 * a paste typed between fences shows as a single code block instead of empty
 * blocks around a separate pasted section. The message text is unchanged.
 */
function groupFencedPastedSegments(segments: PromptDisplaySegment[]): PromptDisplaySegment[] {
  const pastedRanges: Array<{ start: number; end: number }> = []
  let offset = 0
  for (const segment of segments) {
    if (segment.kind === "pasted") pastedRanges.push({ start: offset, end: offset + segment.text.length })
    offset += segment.text.length
  }
  if (pastedRanges.length === 0) return segments

  const text = segments.map((segment) => segment.text).join("")
  const regions = findFencedPasteRegions(text, pastedRanges)
  if (regions.length === 0) return segments

  const grouped: PromptDisplaySegment[] = []
  let regionIndex = 0
  let segmentStart = 0
  for (const segment of segments) {
    const segmentEnd = segmentStart + segment.text.length
    let cursor = segmentStart
    while (cursor < segmentEnd) {
      const region = regions[regionIndex]
      if (region && cursor >= region.start) {
        if (cursor === region.start) {
          grouped.push({
            kind: "pasted",
            text: text.slice(region.contentStart, region.contentEnd),
            codeFence: { marker: region.marker, info: region.info },
          })
        }
        cursor = Math.min(segmentEnd, region.end)
        if (cursor === region.end) regionIndex += 1
        continue
      }
      const stop = region ? Math.min(segmentEnd, region.start) : segmentEnd
      const piece = text.slice(cursor, stop)
      if (segment.kind === "inline") pushInlineSegment(grouped, piece)
      else pushPastedSegment(grouped, piece)
      cursor = stop
    }
    segmentStart = segmentEnd
  }
  return grouped
}
