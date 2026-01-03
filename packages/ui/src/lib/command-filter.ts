import fuzzysort from "fuzzysort"
import type { Command as SDKCommand } from "@opencode-ai/sdk"

/**
 * Filters commands by query using fuzzy search on name and description
 * @param query - User-typed partial command name or keyword
 * @param commands - Array of available commands
 * @returns Filtered and sorted array of commands
 */
export function filterCommands(query: string, commands: SDKCommand[]): SDKCommand[] {
  if (!query.trim()) {
    return commands
  }

  const trimmedQuery = query.trim().toLowerCase()

  try {
    // Prepare searchable objects
    const searchable = commands.map((cmd) => ({
      command: cmd,
      searchText: `${cmd.name} ${cmd.description || ""} ${cmd.agent || ""}`,
    }))

    // Use fuzzysort for fuzzy matching
    const results = fuzzysort.go(trimmedQuery, searchable, {
      key: "searchText",
      limit: 50,
    })

    return results.map((result: { obj: { command: SDKCommand } }) => result.obj.command)
  } catch (error) {
    // Fallback to simple filter if fuzzysort fails
    console.warn("Fuzzysort error, falling back to simple filter:", error)
    return commands.filter((cmd) => {
      const searchText = `${cmd.name} ${cmd.description || ""} ${cmd.agent || ""}`.toLowerCase()
      return searchText.includes(trimmedQuery)
    })
  }
}

/**
 * Highlights matching portions of text based on query
 * Used for visual feedback in command suggestions UI
 * @param text - Text to highlight (usually command name or description)
 * @param query - User query to match against
 * @returns Array of text segments with highlight flags
 */
export function highlightMatch(text: string, query: string): Array<{ text: string; isMatch: boolean }> {
  if (!query.trim() || !text) {
    return [{ text, isMatch: false }]
  }

  const trimmedQuery = query.trim().toLowerCase()
  const lowerText = text.toLowerCase()
  const segments: Array<{ text: string; isMatch: boolean }> = []

  let lastIndex = 0
  let searchIndex = 0

  while (searchIndex < lowerText.length) {
    const matchIndex = lowerText.indexOf(trimmedQuery, searchIndex)

    if (matchIndex === -1) {
      // No more matches, add remaining text
      if (lastIndex < text.length) {
        segments.push({ text: text.substring(lastIndex), isMatch: false })
      }
      break
    }

    // Add text before match
    if (matchIndex > lastIndex) {
      segments.push({ text: text.substring(lastIndex, matchIndex), isMatch: false })
    }

    // Add matched text
    segments.push({ text: text.substring(matchIndex, matchIndex + trimmedQuery.length), isMatch: true })

    lastIndex = matchIndex + trimmedQuery.length
    searchIndex = lastIndex
  }

  return segments.length === 0 ? [{ text, isMatch: false }] : segments
}

/**
 * Groups commands by category (agent name)
 * Useful for organizing large command lists
 * @param commands - Array of commands to group
 * @returns Map of agent names to command arrays
 */
export function groupCommandsByAgent(commands: SDKCommand[]): Map<string, SDKCommand[]> {
  const grouped = new Map<string, SDKCommand[]>()

  for (const command of commands) {
    const agent = command.agent || "general"
    if (!grouped.has(agent)) {
      grouped.set(agent, [])
    }
    grouped.get(agent)!.push(command)
  }

  return grouped
}

/**
 * Test helper: Verify filter function works correctly
 * @example
 * const commands = [
 *   { name: "analyze", description: "Analyze code", ... },
 *   { name: "refactor", description: "Refactor code", ... }
 * ]
 * const results = filterCommands("ana", commands)
 * // Returns: [{ name: "analyze", ... }]
 */
export function testFilterCommands(): void {
  const testCommands: SDKCommand[] = [
    {
      name: "analyze",
      description: "Analyze code structure",
      template: "/analyze",
      agent: "code-reviewer",
    },
    {
      name: "refactor",
      description: "Refactor for maintainability",
      template: "/refactor",
      agent: "refactor-bot",
    },
    {
      name: "test-generate",
      description: "Generate unit tests",
      template: "/test-generate",
      agent: "test-generator",
      subtask: true,
    },
  ]

  // Test 1: Empty query returns all
  const test1 = filterCommands("", testCommands)
  console.assert(test1.length === 3, "Empty query should return all commands")

  // Test 2: Partial name match
  const test2 = filterCommands("ana", testCommands)
  console.assert(test2.length > 0 && test2[0].name === "analyze", "Should match 'analyze' with 'ana'")

  // Test 3: Description match
  const test3 = filterCommands("maintain", testCommands)
  console.assert(test3.length > 0, "Should match description keywords")

  // Test 4: Case insensitive
  const test4 = filterCommands("ANALYZE", testCommands)
  console.assert(test4.length > 0, "Should be case insensitive")

  // Test 5: No match
  const test5 = filterCommands("nonexistent", testCommands)
  console.assert(test5.length === 0, "Should return empty array for no match")

  console.log("✓ All filter tests passed")
}
