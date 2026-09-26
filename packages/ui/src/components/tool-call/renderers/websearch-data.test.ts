import assert from "node:assert/strict"
import { test } from "node:test"
import { parseWebSearchResults } from "./websearch-data"

test("native search content retains titles, sources, dates and literal snippets", () => {
  assert.deepEqual(parseWebSearchResults("## [One](https://example.com/a)\nPublished: 2026-09-26T00:00:00Z\n\n<script>literal</script>\n\n## [Two](https://example.org/)\n\nSecond"), [
    { title: "One", url: "https://example.com/a", host: "example.com", published: "2026-09-26T00:00:00Z", snippet: "<script>literal</script>" },
    { title: "Two", url: "https://example.org/", host: "example.org", snippet: "Second" },
  ])
})

test("unknown, unsafe, oversized and partial formats fall back without losing content", () => {
  for (const value of ["provider error", "## [x](javascript:alert(1))", "## [x](https://u:p@example.com)",
    "## [x](https://example.com)\n## [y](file:///test)", "x".repeat(10_001),
    "No search results found. Custom response", Array(51).fill("## [x](https://example.com)").join("\n")]) {
    assert.equal(parseWebSearchResults(value), undefined)
  }
  assert.deepEqual(parseWebSearchResults("No search results found. Please try a different query."), [])
})
