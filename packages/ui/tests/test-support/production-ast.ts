import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import ts from "typescript"

// Run the actual handler (including awaits and cleanup) with explicit test bindings, without mounting its view.
export function readSource(url: URL) {
  return ts.createSourceFile(url.pathname, readFileSync(url, "utf8"), ts.ScriptTarget.Latest, true)
}

export function evaluateExpression(text: string, scope: Record<string, unknown>) {
  const code = ts.transpileModule(`(${text})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  return new Function("scope", `with (scope) { return ${code} }`)(scope)
}

export function productionHandler(url: URL, name: string, scope: Record<string, unknown>, marker?: string) {
  const file = readSource(url)
  let found: ts.Node | undefined
  function visit(node: ts.Node) {
    if (!marker && ts.isFunctionDeclaration(node) && node.name?.text === name) found = node
    if (!marker && ts.isVariableDeclaration(node) && node.name.getText(file) === name && node.initializer) found = node.initializer
    if (marker && ts.isCallExpression(node) && node.expression.getText(file) === name
      && node.arguments[0]?.getText(file).includes(marker)) found = node.arguments[0]
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(found, `${url.pathname}: ${name}${marker ? ` (${marker})` : ""}`)
  return evaluateExpression(found.getText(file).replace(/^export\s+/, ""), scope)
}

export function productionModule(url: URL, scope: Record<string, unknown>, expose: string[] = []) {
  const file = readSource(url)
  const body = ts.factory.updateSourceFile(file, file.statements.filter(node => !ts.isImportDeclaration(node)))
  const code = ts.transpileModule(ts.createPrinter().printFile(body), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const exports: Record<string, any> = {}
  new Function("exports", ...Object.keys(scope), `${code}\nObject.assign(exports, { ${expose.join(",")} })`)(exports, ...Object.values(scope))
  return exports
}
