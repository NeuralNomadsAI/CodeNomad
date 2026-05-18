export interface HiddenPromptSectionSegment {
  hidden: boolean
  text: string
}

export interface HiddenPromptDisplaySegmentMetadata {
  hidden: boolean
  length: number
}

export interface HiddenPromptDisplayMetadata {
  segments: HiddenPromptDisplaySegmentMetadata[]
}

export interface PreparedPromptDisplayText {
  promptToSend: string
  displayMetadata?: HiddenPromptDisplayMetadata
}

const HIDDEN_PROMPT_TOKEN_REGEX = /<\/codenomad:hide>|<codenomad:hide>|<codenomad:start-hide\s*\/>|<codenomad:end-hide\s*\/>/gi

function normalizeHiddenPromptToken(token: string): string {
  return token.toLowerCase().replace(/\s+/g, "")
}

function isHiddenPromptOpenToken(token: string): boolean {
  return token === "<codenomad:hide>" || token === "<codenomad:start-hide/>"
}

function isHiddenPromptCloseToken(token: string): boolean {
  return token === "</codenomad:hide>" || token === "<codenomad:end-hide/>"
}

function hasHiddenPromptMarkers(text: string): boolean {
  HIDDEN_PROMPT_TOKEN_REGEX.lastIndex = 0
  return HIDDEN_PROMPT_TOKEN_REGEX.test(text)
}

function pushHiddenPromptSectionSegment(segments: HiddenPromptSectionSegment[], hidden: boolean, text: string): void {
  if (!text) return
  const previous = segments[segments.length - 1]
  if (previous && previous.hidden === hidden) {
    previous.text += text
    return
  }
  segments.push({ hidden, text })
}

export function preparePromptDisplayText(text: string): PreparedPromptDisplayText {
  if (!hasHiddenPromptMarkers(text)) {
    return { promptToSend: text }
  }

  HIDDEN_PROMPT_TOKEN_REGEX.lastIndex = 0
  const segments: HiddenPromptSectionSegment[] = []
  let currentHidden = false
  let currentText = ""
  let lastIndex = 0
  let foundHiddenSegment = false

  for (const match of text.matchAll(HIDDEN_PROMPT_TOKEN_REGEX)) {
    const token = match[0]
    const start = match.index ?? 0
    currentText += text.slice(lastIndex, start)

    const normalizedToken = normalizeHiddenPromptToken(token)
    if (isHiddenPromptOpenToken(normalizedToken) && !currentHidden) {
      pushHiddenPromptSectionSegment(segments, false, currentText)
      currentHidden = true
      currentText = ""
    } else if (isHiddenPromptCloseToken(normalizedToken) && currentHidden) {
      pushHiddenPromptSectionSegment(segments, true, currentText)
      foundHiddenSegment = true
      currentHidden = false
      currentText = ""
    } else {
      return { promptToSend: text }
    }

    lastIndex = start + token.length
  }

  currentText += text.slice(lastIndex)

  if (currentHidden) {
    return { promptToSend: text }
  }

  pushHiddenPromptSectionSegment(segments, false, currentText)

  if (!foundHiddenSegment) {
    return { promptToSend: text }
  }

  const promptToSend = segments.map((segment) => segment.text).join("")
  const displayMetadata: HiddenPromptDisplayMetadata = {
    segments: segments.map((segment) => ({ hidden: segment.hidden, length: segment.text.length })),
  }

  return {
    promptToSend,
    displayMetadata,
  }
}

export function splitHiddenPromptSections(
  text: string,
  metadata: HiddenPromptDisplayMetadata | undefined,
): HiddenPromptSectionSegment[] | null {
  if (!metadata || !Array.isArray(metadata.segments) || metadata.segments.length === 0) {
    return null
  }

  const segments: HiddenPromptSectionSegment[] = []
  let offset = 0

  for (const segment of metadata.segments) {
    if (!segment || typeof segment.length !== "number" || segment.length < 0) {
      return null
    }
    const nextOffset = offset + segment.length
    if (nextOffset > text.length) {
      return null
    }
    pushHiddenPromptSectionSegment(segments, Boolean(segment.hidden), text.slice(offset, nextOffset))
    offset = nextOffset
  }

  if (offset !== text.length) {
    return null
  }

  return segments
}
