export interface HiddenPromptSectionSegment {
  hidden: boolean
  text: string
}

export interface PreparedPromptDisplayText {
  promptToSend: string
  displayText?: string
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

export function hasHiddenPromptMarkers(text: string): boolean {
  HIDDEN_PROMPT_TOKEN_REGEX.lastIndex = 0
  return HIDDEN_PROMPT_TOKEN_REGEX.test(text)
}

export function stripHiddenPromptMarkers(text: string): string {
  return text.replace(HIDDEN_PROMPT_TOKEN_REGEX, "")
}

export function preparePromptDisplayText(text: string): PreparedPromptDisplayText {
  if (!hasHiddenPromptMarkers(text)) {
    return { promptToSend: text }
  }

  return {
    promptToSend: stripHiddenPromptMarkers(text),
    displayText: text,
  }
}

export function splitHiddenPromptSections(text: string): HiddenPromptSectionSegment[] {
  HIDDEN_PROMPT_TOKEN_REGEX.lastIndex = 0
  const segments: HiddenPromptSectionSegment[] = []
  let currentHidden = false
  let currentText = ""
  let hiddenStartToken = ""
  let lastIndex = 0

  const pushSegment = (hidden: boolean, value: string) => {
    if (!value) return
    const previous = segments[segments.length - 1]
    if (previous && previous.hidden === hidden) {
      previous.text += value
      return
    }
    segments.push({ hidden, text: value })
  }

  for (const match of text.matchAll(HIDDEN_PROMPT_TOKEN_REGEX)) {
    const token = match[0]
    const start = match.index ?? 0
    currentText += text.slice(lastIndex, start)

    const normalizedToken = normalizeHiddenPromptToken(token)
    if (isHiddenPromptOpenToken(normalizedToken) && !currentHidden) {
      pushSegment(false, currentText)
      currentHidden = true
      currentText = ""
      hiddenStartToken = token
    } else if (isHiddenPromptCloseToken(normalizedToken) && currentHidden) {
      pushSegment(true, currentText)
      currentHidden = false
      currentText = ""
      hiddenStartToken = ""
    } else {
      currentText += token
    }

    lastIndex = start + token.length
  }

  currentText += text.slice(lastIndex)

  if (currentHidden) {
    pushSegment(false, `${hiddenStartToken}${currentText}`)
  } else {
    pushSegment(false, currentText)
  }

  return segments
}
