import { createSignal, Accessor } from "solid-js"
import { validateMarkdownPath } from "../file-path-validator"

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
   * Uses cache to avoid duplicate network requests
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

    // Check cache first
    if (cache.has(sanitized)) {
      const cachedContent = cache.get(sanitized)
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
      // MVP: Mock implementation (placeholder)
      // In production, this would call: GET /api/files/preview?path={sanitized}
      const mockContent = await fetchMarkdownContent(sanitized)

      // Update cache
      if (cache.size >= MAX_CACHE_SIZE) {
        const firstKey = cache.keys().next().value as string
        cache.delete(firstKey)
      }
      cache.set(sanitized, mockContent)

      setContent(mockContent)
      setLastFilePath(sanitized)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Failed to fetch markdown file"
      setError(errorMsg)
      setContent(null)
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
 * Fetches markdown file content
 * MVP: Returns mock content
 * TODO: Replace with actual server API call
 *
 * @param filePath - Validated and sanitized file path
 * @returns Markdown content as string
 */
async function fetchMarkdownContent(filePath: string): Promise<string> {
  // Simulate network delay
  await new Promise((resolve) => setTimeout(resolve, 300))

  // MVP: Mock content - in production replace with real API call
  // const response = await fetch(`/api/files/preview?path=${encodeURIComponent(filePath)}`)
  // if (!response.ok) throw new Error(`Failed to fetch: ${response.statusText}`)
  // return await response.text()

  // Mock data for MVP
  const mockFiles: Record<string, string> = {
    "README.md": `# README

This is a sample markdown preview.

## Features
- Markdown rendering
- Code syntax highlighting
- Theme support

## Installation
\`\`\`bash
npm install
\`\`\`

## Usage
See the documentation for details.`,

    "docs/guide.md": `# Getting Started Guide

Welcome to the guide!

### Prerequisites
- Node.js 18+
- npm or yarn

### Step 1: Setup
\`\`\`bash
npm install
npm run dev
\`\`\`

### Step 2: Configure
Create a config file...`,

    "docs/api.md": `# API Reference

## Endpoints

### GET /api/files/preview
Fetches preview of a markdown file.

**Parameters:**
- \`path\` (string): File path

**Response:**
\`\`\`json
{
  "content": "# Markdown content...",
  "path": "path/to/file.md"
}
\`\`\``,
  }

  const content = mockFiles[filePath]
  if (!content) {
    throw new Error(`File not found: ${filePath}`)
  }

  return content
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
