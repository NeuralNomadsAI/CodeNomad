import assert from "node:assert/strict"
import test from "node:test"
import { fileURLToPath } from "node:url"
import ts from "typescript"

test("the shared memory contract compiles independently with the UI's ES2020 library", () => {
  const contract = fileURLToPath(new URL("../../../server/src/memory/contract.ts", import.meta.url))
  const program = ts.createProgram([contract], {
    target: ts.ScriptTarget.ES2020,
    lib: ["lib.es2020.d.ts"],
    types: [],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  })
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")), [])
  assert.deepEqual(program.getSourceFiles().filter(file => !file.isDeclarationFile).map(file => file.fileName), [program.getSourceFile(contract)!.fileName])
})
