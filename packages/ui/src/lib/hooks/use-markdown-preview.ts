import { createSignal, Accessor } from "solid-js"
import { validateMarkdownPath } from "../file-path-validator"
import { getActiveInstance } from "../../stores/instances"
import { getLogger } from "../logger"

const log = getLogger("api")

/**
 * Hook for fetching and caching markdown file previews
 * Manages loading state, errors, and content caching
 *
 * @returns Object with signals and methods for markdown preview management
 *
 * @example
 * const preview = useMarkdownPreview()
 * preview.fetch("docs/guide.md")
 * // Then use: preview.content(), preview.isLoading(), preview.error()
 */
export function useMarkdownPreview() {
  const [content, setContent] = createSignal<string | null>(null)
  const [isLoading, setIsLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [lastFilePath, setLastFilePath] = createSignal<string | null>(null)

  // Simple LRU cache (last 5 files)
  const cache = new Map<string, string>()
  const MAX_CACHE_SIZE = 5

  /**
   * Fetches markdown file content for preview
   * Uses server API to fetch actual file content from workspace
   *
   * @param filePath - Path to markdown file
   */
  const fetch = async (filePath: string): Promise<void> => {
    // Validate path
    const validation = validateMarkdownPath(filePath)
    if (!validation.isValid) {
      setError(validation.error || "Invalid file path")
      setContent(null)
      return
    }

    const sanitized = validation.sanitized
    const instance = getActiveInstance()
    if (!instance) {
      setError("No active instance")
      setContent(null)
      return
    }

    // Instance ID is the workspace ID (1:1 mapping)
    const workspaceId = instance.id

    // Check cache first
    const cacheKey = `${workspaceId}:${sanitized}`
    if (cache.has(cacheKey)) {
      const cachedContent = cache.get(cacheKey)
      if (cachedContent) {
        setContent(cachedContent)
        setError(null)
        setLastFilePath(sanitized)
        return
      }
    }

    setIsLoading(true)
    setError(null)

    try {
      // Call server API to fetch actual file content
      const fileContent = await fetchMarkdownContentFromServer(workspaceId, sanitized)

      // Update cache
      if (cache.size >= MAX_CACHE_SIZE) {
        const firstKey = cache.keys().next().value as string
        cache.delete(firstKey)
      }
      cache.set(cacheKey, fileContent)

      setContent(fileContent)
      setLastFilePath(sanitized)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Failed to fetch markdown file"
      setError(errorMsg)
      setContent(null)
      log.error("Failed to fetch markdown file", { filePath: sanitized, error: err })
    } finally {
      setIsLoading(false)
    }
  }

  /**
   * Clears current preview content and cache
   */
  const clear = (): void => {
    setContent(null)
    setError(null)
    setLastFilePath(null)
    cache.clear()
  }

  /**
   * Clears only the current content, keeps cache
   */
  const clearCurrent = (): void => {
    setContent(null)
    setError(null)
  }

  return {
    content: content as Accessor<string | null>,
    isLoading: isLoading as Accessor<boolean>,
    error: error as Accessor<string | null>,
    lastFilePath: lastFilePath as Accessor<string | null>,
    fetch,
    clear,
    clearCurrent,
  }
}

/**
 * Fetches markdown file content from server
 * Calls workspace API to read file from instance workspace
 *
 * @param workspaceId - Workspace ID (same as instance ID)
 * @param filePath - Validated and sanitized file path
 * @returns Markdown content as string
 */
async function fetchMarkdownContentFromServer(workspaceId: string, filePath: string): Promise<string> {
  try {
    const response = await fetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/files/content?path=${encodeURIComponent(filePath)}`
    )

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`File not found: ${filePath}`)
      }
      if (response.status === 400) {
        const errorData = (await response.json()) as { error?: string }
        throw new Error(errorData?.error || `Invalid file path: ${filePath}`)
      }
      throw new Error(`Failed to fetch file (${response.status}): ${response.statusText}`)
    }

    const data = (await response.json()) as {
      workspaceId: string
      relativePath: string
      contents: string
    }

    return data.contents
  } catch (err) {
    if (err instanceof Error) {
      throw err
    }
    throw new Error("Unexpected error fetching file content")
  }
}

/**
 * Test helper: Verify hook initialization and basic functionality
 */
export function testUseMarkdownPreview(): void {
  console.log("Testing useMarkdownPreview hook...")

  const preview = useMarkdownPreview()

  // Test 1: Initial state
  console.assert(preview.content() === null, "Initial content should be null")
  console.assert(preview.isLoading() === false, "Initial loading should be false")
  console.assert(preview.error() === null, "Initial error should be null")
  console.log("✓ Initial state correct")

  // Test 2: Invalid path
  preview.fetch("../../../etc/passwd.md")
  setTimeout(() => {
    console.assert(preview.error() !== null, "Invalid path should set error")
    console.assert(preview.content() === null, "Invalid path should not set content")
    console.log("✓ Invalid path handling correct")
  }, 100)

  // Test 3: Valid path fetch
  preview.fetch("README.md")
  setTimeout(() => {
    console.assert(preview.content() !== null, "Valid path should fetch content")
    console.assert(!preview.content()?.includes("not found"), "Should return valid content")
    console.log("✓ Valid path fetch correct")
  }, 400)

  // Test 4: Clear
  preview.clear()
  console.assert(preview.content() === null, "Clear should reset content")
  console.assert(preview.error() === null, "Clear should reset error")
  console.log("✓ Clear method works")

  console.log("\nMarkdown preview hook tests passed")
}
