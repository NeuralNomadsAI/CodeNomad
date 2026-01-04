/**
 * Represents a detected markdown file match in text
 */
export interface MarkdownFileMatch {
  filePath: string
  start: number
  end: number
}

/**
 * Detects markdown file paths in text using regex
 * Matches patterns like: file.md, path/to/file.md, ./relative/path.md
 * Avoids false positives by checking word boundaries
 *
 * @param text - Text to search for markdown files
 * @returns Array of detected markdown file matches with positions
 *
 * @example
 * detectMarkdownFiles("Check the README.md file and docs/guide.md")
 * // Returns: [
 * //   { filePath: "README.md", start: 15, end: 24 },
 * //   { filePath: "docs/guide.md", start: 38, end: 51 }
 * // ]
 */
export function detectMarkdownFiles(text: string): MarkdownFileMatch[] {
  if (!text || typeof text !== "string") {
    return []
  }

  const matches: MarkdownFileMatch[] = []

  // Enhanced regex pattern:
  // - Matches file paths with optional directory separators
  // - Ensures .md extension
  // - Handles relative paths (../, ./, paths with -)
  // - Word boundary protection (not preceded/followed by alphanumerics)
  const pattern = /(?:^|[^\w./\-])([.\w\-/]+\.md)(?=[^\w./\-]|$)/gm

  let match: RegExpExecArray | null

  // eslint-disable-next-line no-cond-assign
  while ((match = pattern.exec(text)) !== null) {
    const filePath = match[1].trim()

    // Additional validation: reject paths with suspicious patterns
    if (isValidMarkdownPath(filePath)) {
      matches.push({
        filePath,
        start: match.index + (match[0].length - filePath.length),
        end: match.index + match[0].length - 1,
      })
    }
  }

  return matches
}

/**
 * Validates markdown file path safety and format
 * Rejects paths with directory traversal attempts, absolute paths, etc.
 *
 * @param filePath - Path to validate
 * @returns true if path is valid and safe
 */
export function isValidMarkdownPath(filePath: string): boolean {
  if (!filePath || typeof filePath !== "string") {
    return false
  }

  const trimmed = filePath.trim()

  // Check length (reasonable file paths)
  if (trimmed.length === 0 || trimmed.length > 255) {
    return false
  }

  // Must end with .md
  if (!trimmed.endsWith(".md")) {
    return false
  }

  // Reject directory traversal
  if (trimmed.includes("..")) {
    return false
  }

  // Reject absolute paths
  if (trimmed.startsWith("/")) {
    return false
  }

  // Reject special characters that shouldn't be in file paths
  // Allow: a-z, A-Z, 0-9, -, _, /, ., space
  const validChars = /^[\w\-./ ]+$/
  if (!validChars.test(trimmed)) {
    return false
  }

  return true
}

/**
 * Sanitizes a markdown file path for safe usage
 * Normalizes slashes, removes whitespace, validates format
 *
 * @param filePath - Raw file path to sanitize
 * @returns Sanitized path or empty string if invalid
 *
 * @example
 * sanitizeMarkdownPath("path/to/ file .md")
 * // Returns: "path/to/file.md"
 */
export function sanitizeMarkdownPath(filePath: string): string {
  if (!filePath || typeof filePath !== "string") {
    return ""
  }

  let sanitized = filePath.trim()

  // Normalize slashes (Unix-style)
  sanitized = sanitized.replace(/\\/g, "/")

  // Remove leading/trailing slashes
  sanitized = sanitized.replace(/^\/+|\/+$/g, "")

  // Remove multiple consecutive slashes
  sanitized = sanitized.replace(/\/+/g, "/")

  // Remove spaces around slashes
  sanitized = sanitized.replace(/\s*\/\s*/g, "/")

  // Remove extra spaces within filename
  sanitized = sanitized.replace(/\s+/g, " ")

  // Final validation
  if (!isValidMarkdownPath(sanitized)) {
    return ""
  }

  return sanitized
}

/**
 * Extracts all markdown file references from text with additional context
 * Useful for building a preview index or file list
 *
 * @param text - Text to search
 * @returns Array of markdown file info objects
 */
export interface MarkdownFileInfo {
  filePath: string
  isValid: boolean
  sanitized: string
  error?: string
}

export function extractMarkdownFileInfo(text: string): MarkdownFileInfo[] {
  const matches = detectMarkdownFiles(text)

  return matches.map((match) => {
    const sanitized = sanitizeMarkdownPath(match.filePath)
    const isValid = sanitized.length > 0

    return {
      filePath: match.filePath,
      isValid,
      sanitized,
      error: isValid ? undefined : `Invalid markdown path: ${match.filePath}`,
    }
  })
}

/**
 * Test function to verify markdown detection works correctly
 * Can be called during development to validate patterns
 */
export function testMarkdownDetection(): void {
  const testCases = [
    {
      text: "Check the README.md file",
      expected: ["README.md"],
    },
    {
      text: "See docs/guide.md and ./setup.md for details",
      expected: ["docs/guide.md", "./setup.md"],
    },
    {
      text: "file.markdown and test.md exist",
      expected: ["test.md"],
    },
    {
      text: "Multiple: src/index.md, docs/api.md, README.md",
      expected: ["src/index.md", "docs/api.md", "README.md"],
    },
    {
      text: "Invalid ../etc/passwd.md should be rejected",
      expected: [],
    },
    {
      text: "/absolute/path.md not allowed",
      expected: [],
    },
  ]

  let passed = 0
  for (const testCase of testCases) {
    const results = detectMarkdownFiles(testCase.text)
    const resultPaths = results.map((r) => r.filePath)
    const isMatch = JSON.stringify(resultPaths) === JSON.stringify(testCase.expected)

    if (isMatch) {
      console.log(`✓ Test passed: "${testCase.text}"`)
      passed++
    } else {
      console.warn(
        `✗ Test failed: "${testCase.text}"\n  Expected: ${testCase.expected.join(", ")}\n  Got: ${resultPaths.join(", ")}`
      )
    }
  }

  console.log(`\nMarkdown detection: ${passed}/${testCases.length} tests passed`)
}
