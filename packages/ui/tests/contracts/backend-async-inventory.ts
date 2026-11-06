import { readdirSync, readFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

export const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../src")
export const architecture = resolve(sourceRoot, "../../../dev-docs/architecture.md")
export const manifestPath = resolve(sourceRoot, "../../../scripts/backend-async-operations.json")
const backendNames = /^(?:fetch|fetcher|fetchImpl|serverApi|backendOf|OpenCodeClients|sdkManager|authenticatedFetch|captureBackendOperation|backendEvents|serverEvents|getRootClient|getSessionClient|EventSource|WebSocket|XMLHttpRequest|sendBeacon|toolImageSource|Image|Audio)$/
const deferredCall = /(?:^|\.)(?:setTimeout|setInterval|queueMicrotask|requestAnimationFrame|then|catch|finally)$/
const subscriptionCall = /(?:^|\.)(?:subscribe|addEventListener|onOpen|onDetach|onTransportStatus|onEvent|on|once|listen|watch)$/
const backendImport = /(?:api-client|server-events|backend-events|backend-client|backend-operation|sdk-manager|opencode-client|integrations-api|panel-extensions-api)$/

export interface Classification { lifetime: string; families: string; authority: string }
export interface FileOperations { classification: Classification; operations: string[] }
export type Manifest = Record<string, FileOperations>

export function parseInventory(document: string): Map<string, Classification> {
  const section = document.split("<!-- backend-async-inventory:start -->")[1]?.split("<!-- backend-async-inventory:end -->")[0]
  if (!section) throw new Error("architecture.md must contain the backend async inventory")
  const rows = new Map<string, Classification>()
  for (const line of section.split(/\r?\n/)) {
    const row = /^\| (`.+`) \| ((?:A|C|P|V|DOM|IPC|EXTERNAL|COMPUTE)(?:\+(?:A|C|P|V|DOM|IPC|EXTERNAL|COMPUTE))*) \| (.+) \| (.+) \|$/.exec(line)
    if (!row) continue
    for (const match of row[1].matchAll(/`([^`]+\.(?:ts|tsx))`/g)) {
      if (rows.has(match[1])) throw new Error(`duplicate inventory row: ${match[1]}`)
      rows.set(match[1], { lifetime: row[2], families: row[3], authority: row[4] })
    }
  }
  return rows
}

export function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? sources(path)
      : /\.tsx?$/.test(entry.name) && !/(?:\.test\.|\.d\.ts$)/.test(entry.name) ? [path] : []
  }).sort()
}

// Structural names deliberately omit source positions, whitespace and function bodies.
function expressionName(node: ts.Node): string {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) return `${expressionName(node.expression)}.${node.name.text}`
  if (ts.isElementAccessExpression(node)) return `${expressionName(node.expression)}[${expressionName(node.argumentExpression)}]`
  if (ts.isCallExpression(node)) return `${expressionName(node.expression)}()`
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) return expressionName(node.expression)
  return ts.SyntaxKind[node.kind]
}

function functionName(node: ts.FunctionLikeDeclaration): string {
  if (node.name) return expressionName(node.name)
  const parent = node.parent
  if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) return expressionName(parent.name)
  if (ts.isBinaryExpression(parent)) return expressionName(parent.left)
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
    return `${expressionName(parent.expression)}:arg${parent.arguments?.indexOf(node as ts.Expression)}`
  }
  if (ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent)) return `jsx:${expressionName(parent.parent.name)}`
  return ts.isConstructorDeclaration(node) ? "constructor" : "callback"
}

export function scanOperations(file: string, text: string, checkedSource?: ts.SourceFile, checker?: ts.TypeChecker): string[] {
  const source = checkedSource ?? ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const operations: string[] = []
  const counts = new Map<string, number>()
  const contexts = new Map<string, number>()
  const backendAliases = new Set<string>()
  const promiseLike = (type: ts.Type): boolean => type.isUnion()
    ? type.types.some(promiseLike) : !!type.getProperty("then")
  function add(context: string, kind: string, callee: string) {
    const base = `${context}::${kind}:${callee}`
    const ordinal = (counts.get(base) ?? 0) + 1
    counts.set(base, ordinal)
    operations.push(`${base}#${ordinal}`)
  }
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly
      || !ts.isStringLiteral(statement.moduleSpecifier) || !backendImport.test(statement.moduleSpecifier.text)) continue
    const clause = statement.importClause
    if (clause?.name) backendAliases.add(clause.name.text)
    if (clause?.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) backendAliases.add(clause.namedBindings.name.text)
      else for (const binding of clause.namedBindings.elements) if (!binding.isTypeOnly) backendAliases.add(binding.name.text)
    }
  }
  function visit(node: ts.Node, parentContext: string) {
    let context = parentContext
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) context += `/${node.name?.text ?? "class"}`
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
      || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) {
      const base = `${context}/${functionName(node)}`
      const ordinal = (contexts.get(base) ?? 0) + 1
      contexts.set(base, ordinal)
      context = ordinal === 1 ? base : `${base}~${ordinal}`
      if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
        add(context, "async", "function")
      }
    }
    if (ts.isAwaitExpression(node)) add(context, "await", expressionName(node.expression))
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly
      && ts.isStringLiteral(node.moduleSpecifier) && backendImport.test(node.moduleSpecifier.text)) add(context, "backend-import", node.moduleSpecifier.text)
    if (ts.isIdentifier(node) && backendNames.test(node.text)) add(context, "backend-symbol", node.text)
    if (ts.isNewExpression(node) && /^(?:Promise|EventSource|WebSocket|XMLHttpRequest|Image|Audio)$/.test(expressionName(node.expression))) {
      add(context, "construct", expressionName(node.expression))
    }
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
      && /^(?:img|iframe|audio|video|source|embed|object)$/.test(node.tagName.getText(source))) add(context, "resource", expressionName(node.tagName))
    if (ts.isBinaryExpression(node) && ts.isPropertyAccessExpression(node.left) && node.left.name.text === "src") add(context, "resource", expressionName(node.left))
    if (ts.isCallExpression(node)) {
      const callee = expressionName(node.expression)
      if (deferredCall.test(callee)) add(context, "deferred", callee)
      else if (subscriptionCall.test(callee)) add(context, "subscription", callee)
      else if (backendNames.test(callee.split(".").at(-1) ?? "") || backendAliases.has(callee.split(/[.([]/)[0])) add(context, "backend-call", callee)
      else if (checker && promiseLike(checker.getTypeAtLocation(node))) add(context, "promise-call", callee)
      if (checker) for (const [index, argument] of node.arguments.entries()) {
        if (checker.getNonNullableType(checker.getTypeAtLocation(argument)).getCallSignatures()
          .some(signature => promiseLike(signature.getReturnType()))) add(context, "async-argument", `${callee}:arg${index}`)
      }
    }
    ts.forEachChild(node, child => visit(child, context))
  }
  visit(source, "module")
  return operations.sort()
}

export function requiresClassification(file: string, text: string, source?: ts.SourceFile, checker?: ts.TypeChecker): boolean {
  return scanOperations(file, text, source, checker).length > 0
}

export function inventoryProgram() {
  const files = sources(sourceRoot)
  const configFile = resolve(sourceRoot, "../tsconfig.json")
  const config = ts.readConfigFile(configFile, ts.sys.readFile)
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"))
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configFile))
  return ts.createProgram(files, parsed.options)
}

export function discoverOperations(program: ts.Program): Record<string, string[]> {
  const checker = program.getTypeChecker()
  return Object.fromEntries(sources(sourceRoot).map(file => {
    const source = program.getSourceFile(file)!
    return [relative(sourceRoot, file).replace(/\\/g, "/"), scanOperations(file, source.text, source, checker)]
  }))
}

// Explicit candidate output only. New operations require a human classification;
// tests only read the checked-in manifest and never invoke this command.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const previous = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest
  const rows = parseInventory(readFileSync(architecture, "utf8"))
  const candidate = Object.fromEntries(Object.entries(discoverOperations(inventoryProgram()))
    .filter(([file, operations]) => operations.length || rows.has(file))
    .map(([file, operations]) => [file, {
      classification: previous[file]?.classification ?? null,
      operations: operations.map(id => ({ id, inherits: previous[file]?.operations.includes(id) ? file : null })),
    }]))
  process.stdout.write(`${JSON.stringify(candidate, null, 2)}\n`)
}
