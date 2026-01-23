/**
 * Directive Parser Utility
 * Parses markdown directive files into structured data for card views
 */

/**
 * A single parsed directive item
 */
export interface ParsedDirective {
  id: string                // Unique hash based on content + line number
  text: string              // The directive text (cleaned)
  section?: string          // Parent section from header
  type: "bullet" | "paragraph"
  lineNumber: number
  original: string          // Original markdown line
}

/**
 * A section containing directives
 */
export interface DirectiveSection {
  title: string
  directives: ParsedDirective[]
  level: number             // Header level (1-6)
  lineNumber: number
}

/**
 * Generate a simple hash for directive identification
 */
function generateId(content: string, lineNumber: number): string {
  let hash = 0
  const str = `${content}:${lineNumber}`
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32-bit integer
  }
  return `dir_${Math.abs(hash).toString(16)}`
}

/**
 * Check if a line is a horizontal rule
 */
function isHorizontalRule(line: string): boolean {
  const trimmed = line.trim()
  // Match ---, ***, ___ with optional spaces between
  return /^[-*_]{3,}$/.test(trimmed) || /^[-*_](\s*[-*_]){2,}$/.test(trimmed)
}

/**
 * Check if a line is an HTML comment
 */
function isHtmlComment(line: string): boolean {
  const trimmed = line.trim()
  // Match <!-- anything --> on a single line
  return /^<!--.*-->$/.test(trimmed)
}

/**
 * Check if a line looks like YAML frontmatter content
 */
function isYamlLikeLine(line: string): boolean {
  const trimmed = line.trim()
  // Match common YAML patterns: key: value
  return /^[a-zA-Z_][a-zA-Z0-9_]*:\s*.+$/.test(trimmed)
}

/**
 * Check if a paragraph is likely meta/description text (not a directive)
 */
function isMetaParagraph(text: string): boolean {
  // Common meta paragraph patterns
  const metaPatterns = [
    /^this (document|file|section) (defines|describes|contains|outlines)/i,
    /^this is an? (example|sample|placeholder|template)/i,
    /^directives (are|may|should|must|can)/i,
    /^the following (are|is|describes|outlines)/i,
    /^below (are|is) (a list|the)/i,
    /^see (also|the|our)/i,
    /^note:/i,
    /^important:/i,
    /^warning:/i,
    /^for more (information|details)/i,
    /^\*\*important:\*\*/i,
    /^\*\*note:\*\*/i,
    /^replace this with/i,
    /^add .+ here/i,
    /^an? .+-first approach/i,  // "An investigative-first approach..."
    /reduces the risk of/i,
    /demonstrating the format/i,
  ]

  return metaPatterns.some(pattern => pattern.test(text))
}

/**
 * Clean directive text by removing markdown formatting
 */
function cleanDirectiveText(text: string): string {
  return text
    .replace(/^[-*+]\s+/, "")           // Remove list markers
    .replace(/^\d+\.\s+/, "")           // Remove numbered list markers
    .replace(/\*\*([^*]+)\*\*/g, "$1")  // Remove bold **text**
    .replace(/\*([^*]+)\*/g, "$1")      // Remove italic *text*
    .replace(/__([^_]+)__/g, "$1")      // Remove bold __text__
    .replace(/_([^_]+)_/g, "$1")        // Remove italic _text_
    .replace(/`([^`]+)`/g, "$1")        // Remove inline code `text`
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")  // Remove links [text](url) -> text
    .trim()
}

/**
 * Check if a line is a header
 */
function isHeader(line: string): { isHeader: boolean; level: number; title: string } {
  const match = line.match(/^(#{1,6})\s+(.+)$/)
  if (match) {
    return { isHeader: true, level: match[1].length, title: match[2].trim() }
  }
  return { isHeader: false, level: 0, title: "" }
}

/**
 * Check if a line is a bullet point
 */
function isBulletPoint(line: string): boolean {
  return /^[-*+]\s+/.test(line) || /^\d+\.\s+/.test(line)
}

/**
 * Parse markdown content into structured directive sections
 */
export function parseDirectivesMarkdown(content: string): DirectiveSection[] {
  if (!content || typeof content !== "string") {
    return []
  }

  const lines = content.split("\n")
  const sections: DirectiveSection[] = []
  let currentSection: DirectiveSection | null = null

  // Track YAML frontmatter state
  let inFrontmatter = false
  let frontmatterEnded = false
  let frontmatterStartLine = -1

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNumber = i + 1
    const trimmedLine = line.trim()

    // Skip empty lines
    if (!trimmedLine) continue

    // Handle YAML frontmatter detection
    // Frontmatter must start at line 1 with ---
    if (trimmedLine === "---") {
      if (lineNumber === 1 || (inFrontmatter === false && frontmatterEnded === false && lineNumber <= 2)) {
        inFrontmatter = true
        frontmatterStartLine = lineNumber
        continue
      } else if (inFrontmatter) {
        // End of frontmatter
        inFrontmatter = false
        frontmatterEnded = true
        continue
      }
    }

    // Skip lines inside frontmatter
    if (inFrontmatter) {
      continue
    }

    // Skip horizontal rules (---, ***, ___)
    if (isHorizontalRule(trimmedLine)) {
      continue
    }

    // Skip HTML comments (<!-- ... -->)
    if (isHtmlComment(trimmedLine)) {
      continue
    }

    // Skip YAML-like lines that aren't in a proper section yet (metadata remnants)
    if (!currentSection && isYamlLikeLine(trimmedLine)) {
      continue
    }

    // Check for headers
    const headerInfo = isHeader(trimmedLine)
    if (headerInfo.isHeader) {
      // Save previous section if it has directives
      if (currentSection && currentSection.directives.length > 0) {
        sections.push(currentSection)
      }

      currentSection = {
        title: headerInfo.title,
        directives: [],
        level: headerInfo.level,
        lineNumber,
      }
      continue
    }

    // Check for bullet points - these are always directives
    if (isBulletPoint(trimmedLine)) {
      const cleanedText = cleanDirectiveText(trimmedLine)
      if (cleanedText) {
        const directive: ParsedDirective = {
          id: generateId(cleanedText, lineNumber),
          text: cleanedText,
          section: currentSection?.title,
          type: "bullet",
          lineNumber,
          original: line,
        }

        if (currentSection) {
          currentSection.directives.push(directive)
        } else {
          // Create a default section for orphan directives
          currentSection = {
            title: "General",
            directives: [directive],
            level: 1,
            lineNumber: 1,
          }
        }
      }
      continue
    }

    // For paragraphs, only include if they look like actual directives
    // Skip meta/description paragraphs
    if (trimmedLine && !trimmedLine.startsWith("#")) {
      // Skip meta paragraphs (descriptions, notes, etc.)
      if (isMetaParagraph(trimmedLine)) {
        continue
      }

      // Skip very long paragraphs (likely descriptions, not directives)
      // Directives are typically concise (under 200 chars)
      if (trimmedLine.length > 250) {
        continue
      }

      // Skip if it's just YAML-like content
      if (isYamlLikeLine(trimmedLine)) {
        continue
      }

      const cleanedText = cleanDirectiveText(trimmedLine)
      if (cleanedText && cleanedText.length > 3) {  // Avoid tiny fragments
        const directive: ParsedDirective = {
          id: generateId(cleanedText, lineNumber),
          text: cleanedText,
          section: currentSection?.title,
          type: "paragraph",
          lineNumber,
          original: line,
        }

        if (currentSection) {
          currentSection.directives.push(directive)
        } else {
          currentSection = {
            title: "General",
            directives: [directive],
            level: 1,
            lineNumber: 1,
          }
        }
      }
    }
  }

  // Don't forget the last section
  if (currentSection && currentSection.directives.length > 0) {
    sections.push(currentSection)
  }

  return sections
}

/**
 * Convert parsed sections back to markdown
 */
export function directivesToMarkdown(sections: DirectiveSection[]): string {
  if (!sections || sections.length === 0) {
    return ""
  }

  const lines: string[] = []

  for (const section of sections) {
    // Add header
    const headerMarker = "#".repeat(section.level)
    lines.push(`${headerMarker} ${section.title}`)
    lines.push("")

    // Add directives
    for (const directive of section.directives) {
      if (directive.type === "bullet") {
        lines.push(`- ${directive.text}`)
      } else {
        lines.push(directive.text)
      }
    }

    lines.push("")
  }

  return lines.join("\n").trim() + "\n"
}

/**
 * Add a new directive to sections
 */
export function addDirective(
  sections: DirectiveSection[],
  text: string,
  sectionTitle?: string
): DirectiveSection[] {
  const newSections = sections.map(s => ({
    ...s,
    directives: [...s.directives],
  }))

  const cleanedText = cleanDirectiveText(text)
  const targetSection = sectionTitle || "General"

  // Find or create the section
  let section = newSections.find(s => s.title.toLowerCase() === targetSection.toLowerCase())

  if (!section) {
    // Create new section
    const lastLineNumber = newSections.length > 0
      ? Math.max(...newSections.flatMap(s => s.directives.map(d => d.lineNumber)), 0) + 2
      : 1

    section = {
      title: targetSection,
      directives: [],
      level: 2,
      lineNumber: lastLineNumber,
    }
    newSections.push(section)
  }

  // Add directive
  const lastDirectiveLine = section.directives.length > 0
    ? Math.max(...section.directives.map(d => d.lineNumber)) + 1
    : section.lineNumber + 1

  section.directives.push({
    id: generateId(cleanedText, lastDirectiveLine),
    text: cleanedText,
    section: section.title,
    type: "bullet",
    lineNumber: lastDirectiveLine,
    original: `- ${cleanedText}`,
  })

  return newSections
}

/**
 * Remove a directive by ID
 */
export function removeDirective(sections: DirectiveSection[], id: string): DirectiveSection[] {
  return sections
    .map(section => ({
      ...section,
      directives: section.directives.filter(d => d.id !== id),
    }))
    .filter(section => section.directives.length > 0)
}

/**
 * Update a directive's text by ID
 */
export function updateDirective(
  sections: DirectiveSection[],
  id: string,
  newText: string
): DirectiveSection[] {
  const cleanedText = cleanDirectiveText(newText)

  return sections.map(section => ({
    ...section,
    directives: section.directives.map(directive =>
      directive.id === id
        ? {
            ...directive,
            text: cleanedText,
            original: directive.type === "bullet" ? `- ${cleanedText}` : cleanedText,
          }
        : directive
    ),
  }))
}

/**
 * Get all unique section titles from parsed sections
 */
export function getSectionTitles(sections: DirectiveSection[]): string[] {
  return sections.map(s => s.title)
}

/**
 * Get total directive count
 */
export function getDirectiveCount(sections: DirectiveSection[]): number {
  return sections.reduce((count, section) => count + section.directives.length, 0)
}

/**
 * Find a directive by ID
 */
export function findDirectiveById(
  sections: DirectiveSection[],
  id: string
): ParsedDirective | null {
  for (const section of sections) {
    const directive = section.directives.find(d => d.id === id)
    if (directive) return directive
  }
  return null
}

/**
 * Get section color based on title
 */
export function getSectionColor(title: string): string {
  const lowerTitle = title.toLowerCase()

  if (lowerTitle.includes("security") || lowerTitle.includes("prohibited")) {
    return "red"
  }
  if (lowerTitle.includes("code") || lowerTitle.includes("style") || lowerTitle.includes("format")) {
    return "blue"
  }
  if (lowerTitle.includes("git") || lowerTitle.includes("workflow")) {
    return "purple"
  }
  if (lowerTitle.includes("test") || lowerTitle.includes("testing")) {
    return "green"
  }
  if (lowerTitle.includes("architecture") || lowerTitle.includes("structure")) {
    return "orange"
  }
  if (lowerTitle.includes("dependency") || lowerTitle.includes("dependencies")) {
    return "cyan"
  }

  return "gray"
}
