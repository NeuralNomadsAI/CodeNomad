/**
 * Markdown file information with validation status
 */
export interface MarkdownFileValidationResult {
  filePath: string
  isValid: boolean
  sanitized: string
  error?: string
  message?: string
}

/**
 * Validates markdown file path for safety and format correctness
 * Checks for:
 * - Valid length (1-255 characters)
 * - .md extension
 * - No directory traversal (no ..)
 * - No absolute paths (no leading /)
 * - Only safe characters: a-z, A-Z, 0-9, -, _, /, ., space
 *
 * @param filePath - File path to validate
 * @returns true if path is valid and safe to use
 *
 * @example
 * isValidMarkdownPath("docs/guide.md")      // true
 * isValidMarkdownPath("../../../etc/passwd") // false
 * isValidMarkdownPath("/absolute/path.md")   // false
 */
export function isValidMarkdownPath(filePath: string): boolean {
  if (!filePath || typeof filePath !== "string") {
    return false
  }

  const trimmed = filePath.trim()

  // Check length (reasonable file paths, max 255 per filesystem limits)
  if (trimmed.length === 0 || trimmed.length > 255) {
    return false
  }

  // Must end with .md extension
  if (!trimmed.toLowerCase().endsWith(".md")) {
    return false
  }

  // Reject directory traversal attempts
  if (trimmed.includes("..")) {
    return false
  }

  // Reject absolute paths (security: prevent escaping intended directory)
  if (trimmed.startsWith("/")) {
    return false
  }

  // Reject special characters that could be malicious
  // Allow: alphanumeric, hyphen, underscore, forward slash, dot, space
  const safeCharsPattern = /^[\w\-./ ]+$/
  if (!safeCharsPattern.test(trimmed)) {
    return false
  }

  // Ensure no control characters or problematic whitespace
  if (/[\x00-\x1F\x7F]/.test(trimmed)) {
    return false
  }

  return true
}

/**
 * Sanitizes a markdown file path to ensure safe usage
 * - Trims whitespace
 * - Normalizes slashes to Unix-style (/)
 * - Removes leading/trailing slashes
 * - Removes multiple consecutive slashes
 * - Cleans up spacing around separators
 * - Validates final result
 *
 * @param filePath - Raw file path to sanitize
 * @returns Sanitized path, or empty string if path is invalid after sanitization
 *
 * @example
 * sanitizeMarkdownPath("  path/to//file .md  ")
 * // Returns: "path/to/file.md"
 *
 * sanitizeMarkdownPath("../../../etc/passwd.md")
 * // Returns: "" (invalid after sanitization)
 */
export function sanitizeMarkdownPath(filePath: string): string {
  if (!filePath || typeof filePath !== "string") {
    return ""
  }

  let sanitized = filePath.trim()

  // Normalize slashes: Windows \ to Unix /
  sanitized = sanitized.replace(/\\/g, "/")

  // Remove leading/trailing slashes
  sanitized = sanitized.replace(/^\/+|\/+$/g, "")

  // Remove multiple consecutive slashes (// → /)
  sanitized = sanitized.replace(/\/+/g, "/")

  // Remove spaces around slashes (/ a / → /a/)
  sanitized = sanitized.replace(/\s*\/\s*/g, "/")

  // Clean extra spaces in filenames (but preserve single spaces)
  sanitized = sanitized.replace(/\s{2,}/g, " ")

  // Validate final result before returning
  if (!isValidMarkdownPath(sanitized)) {
    return ""
  }

  return sanitized
}

/**
 * Validates and sanitizes a markdown path, returning detailed result
 * Combines validation and sanitization with error messages
 *
 * @param filePath - File path to validate
 * @returns Detailed validation result with error messages if applicable
 *
 * @example
 * const result = validateMarkdownPath("docs/guide.md")
 * if (result.isValid) {
 *   console.log("Safe path:", result.sanitized)
 * } else {
 *   console.error("Error:", result.error)
 * }
 */
export function validateMarkdownPath(filePath: string): MarkdownFileValidationResult {
  if (!filePath || typeof filePath !== "string") {
    return {
      filePath,
      isValid: false,
      sanitized: "",
      error: "Path must be a non-empty string",
    }
  }

  const trimmed = filePath.trim()

  // Check empty
  if (trimmed.length === 0) {
    return {
      filePath,
      isValid: false,
      sanitized: "",
      error: "Path cannot be empty",
    }
  }

  // Check length
  if (trimmed.length > 255) {
    return {
      filePath,
      isValid: false,
      sanitized: "",
      error: "Path exceeds maximum length of 255 characters",
    }
  }

  // Check .md extension
  if (!trimmed.toLowerCase().endsWith(".md")) {
    return {
      filePath,
      isValid: false,
      sanitized: "",
      error: 'Path must end with ".md" extension',
    }
  }

  // Check for directory traversal
  if (trimmed.includes("..")) {
    return {
      filePath,
      isValid: false,
      sanitized: "",
      error: "Path cannot contain directory traversal (..) sequences",
    }
  }

  // Check for absolute path
  if (trimmed.startsWith("/")) {
    return {
      filePath,
      isValid: false,
      sanitized: "",
      error: "Absolute paths are not allowed, use relative paths",
    }
  }

  // Check for invalid characters
  const safeCharsPattern = /^[\w\-./ ]+$/
  if (!safeCharsPattern.test(trimmed)) {
    return {
      filePath,
      isValid: false,
      sanitized: "",
      error: "Path contains invalid characters. Only alphanumeric, hyphen, underscore, forward slash, dot, and space are allowed",
    }
  }

  // Check for control characters
  if (/[\x00-\x1F\x7F]/.test(trimmed)) {
    return {
      filePath,
      isValid: false,
      sanitized: "",
      error: "Path contains control characters",
    }
  }

  // Sanitize the path
  const sanitized = sanitizeMarkdownPath(filePath)

  if (sanitized.length === 0) {
    return {
      filePath,
      isValid: false,
      sanitized: "",
      error: "Path failed sanitization validation",
    }
  }

  return {
    filePath,
    isValid: true,
    sanitized,
    message: `Path is valid: "${sanitized}"`,
  }
}

/**
 * Test function to verify validation works correctly
 * Validates test cases with expected results
 */
export function testPathValidation(): void {
  const testCases = [
    // Valid paths
    { path: "README.md", shouldPass: true },
    { path: "docs/guide.md", shouldPass: true },
    { path: "./setup.md", shouldPass: true },
    { path: "path-with-dash.md", shouldPass: true },
    { path: "path_with_underscore.md", shouldPass: true },
    { path: "nested/path/to/file.md", shouldPass: true },
    { path: "  spaces  around  .md  ", shouldPass: true },

    // Invalid paths
    { path: "../../../etc/passwd.md", shouldPass: false },
    { path: "/absolute/path.md", shouldPass: false },
    { path: "file.txt", shouldPass: false },
    { path: "path with special@chars.md", shouldPass: false },
    { path: "", shouldPass: false },
    { path: "a".repeat(256) + ".md", shouldPass: false },
  ]

  let passed = 0
  for (const testCase of testCases) {
    const result = validateMarkdownPath(testCase.path)
    const didPass = result.isValid === testCase.shouldPass

    if (didPass) {
      console.log(`✓ Test passed: "${testCase.path}" → ${testCase.shouldPass ? "valid" : "invalid"}`)
      passed++
    } else {
      console.warn(`✗ Test failed: "${testCase.path}"
  Expected: ${testCase.shouldPass ? "valid" : "invalid"}
  Got: ${result.isValid ? "valid" : "invalid"}
  Error: ${result.error || "none"}`)
    }
  }

  console.log(`\nPath validation: ${passed}/${testCases.length} tests passed`)
}
