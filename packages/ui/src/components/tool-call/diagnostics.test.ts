import assert from "node:assert/strict"
import test from "node:test"
import { selectSeverityBounded } from "./diagnostic-selection.ts"
import { buildDiagnosticView, extractDiagnosticsView } from "./diagnostics.ts"
import { formatUnknownForCopy } from "./utils.ts"

test("diagnostic bounds retain errors that follow informational entries", () => {
  const diagnostics = [
      ...Array.from({ length: 100 }, (_, index) => ({ message: `info ${index}`, severity: 3 })),
      { message: "the error", severity: 1 },
    ]
  const entries = selectSeverityBounded(diagnostics, (entry) => entry.severity === 1 ? 0 : 2, 100)
  assert.equal(entries.length, 100)
  assert.equal(entries[0]?.message, "the error")
})

test("bounded diagnostics expose truncation and retain the complete copy payload", () => {
  const longMessage = `${"x".repeat(2_000)}COPY_TAIL`
  const diagnostics = {
    "src/file.ts": [
      { message: longMessage, severity: 1 },
      ...Array.from({ length: 100 }, (_, index) => ({ message: `warning ${index}`, severity: 2 })),
    ],
  }
  const view = buildDiagnosticView(diagnostics, ["src/file.ts"])

  assert.equal(view.entries.length, 100)
  assert.equal(view.entries[0]?.message.includes("COPY_TAIL"), false)
  assert.equal(view.truncated, true)
  assert.equal(formatUnknownForCopy(view.diagnostics)?.text.includes("COPY_TAIL"), true)
})

test("unmatched diagnostic paths still expose the complete payload", () => {
  const view = extractDiagnosticsView({
    status: "completed",
    input: { filePath: "src/requested.ts" },
    metadata: { diagnostics: { "src/reported.ts": [{ message: "SEARCH_MATCH" }] } },
    output: "",
  } as any)

  assert.equal(view.entries.length, 0)
  assert.equal(view.truncated, true)
  assert.equal(formatUnknownForCopy(view.diagnostics)?.text.includes("SEARCH_MATCH"), true)
})
