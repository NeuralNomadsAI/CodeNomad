import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import ts from "typescript"

// On Windows the Electron backend has no console: a console program it starts
// without windowsHide opens its own visible console window.
const root = path.dirname(fileURLToPath(import.meta.url))
const CHILD_PROCESS = /^(node:)?child_process$/
const METHODS = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])
const EXEMPTION = "console-window:"

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sources(file)
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts") ? [file] : []
  })
}

/** Calls of child_process functions, including `promisify(execFile)` aliases. */
function childProcessCalls(file: string): Array<{ line: number; text: string; exempt: boolean }> {
  const text = readFileSync(file, "utf8")
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const lines = text.split(/\r?\n/)
  const bindings = new Set<string>()
  const namespaces = new Set<string>()
  const visitImports = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && CHILD_PROCESS.test(node.moduleSpecifier.text)) {
      const clause = node.importClause
      if (clause?.name) namespaces.add(clause.name.text)
      const named = clause?.namedBindings
      if (named && ts.isNamespaceImport(named)) namespaces.add(named.name.text)
      if (named && ts.isNamedImports(named)) for (const element of named.elements) {
        if (METHODS.has((element.propertyName ?? element.name).text)) bindings.add(element.name.text)
      }
    }
    // `const { execFile } = load("node:child_process")`
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer
      && /child_process/.test(node.initializer.getText(source))) {
      for (const element of node.name.elements) {
        const name = (element.propertyName ?? element.name).getText(source)
        if (METHODS.has(name) && ts.isIdentifier(element.name)) bindings.add(element.name.text)
      }
    }
    ts.forEachChild(node, visitImports)
  }
  visitImports(source)
  const isChildProcessFunction = (node: ts.Expression): boolean => {
    if (ts.isIdentifier(node)) return bindings.has(node.text)
    return ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
      && namespaces.has(node.expression.text) && METHODS.has(node.name.text)
  }
  const promisified = new Set<string>()
  const isPromisify = (node: ts.Expression) => ts.isCallExpression(node) && node.expression.getText(source).endsWith("promisify")
    && node.arguments.length === 1 && isChildProcessFunction(node.arguments[0]!)
  const visitAliases = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isPromisify(node.initializer)) {
      promisified.add(node.name.text)
    }
    ts.forEachChild(node, visitAliases)
  }
  visitAliases(source)
  const calls: Array<{ line: number; text: string; exempt: boolean }> = []
  const visitCalls = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (isChildProcessFunction(callee) || isPromisify(callee) || (ts.isIdentifier(callee) && promisified.has(callee.text))) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line
        calls.push({ line: line + 1, text: node.getText(source),
          exempt: lines.slice(Math.max(0, line - 2), line + 1).some(candidate => candidate.includes(EXEMPTION)) })
      }
    }
    ts.forEachChild(node, visitCalls)
  }
  visitCalls(source)
  return calls
}

test("every server child process hides its console window unless a comment explains why not", () => {
  const missing: string[] = []
  let checked = 0
  for (const file of sources(root)) {
    for (const call of childProcessCalls(file)) {
      checked++
      if (!call.exempt && !/\bwindowsHide\s*:\s*true\b/.test(call.text)) missing.push(`${path.relative(root, file)}:${call.line}`)
    }
  }
  assert.ok(checked > 30, `found only ${checked} child process calls`)
  assert.deepEqual(missing, [], `add windowsHide: true, or a "${EXEMPTION} <reason>" comment`)
})
