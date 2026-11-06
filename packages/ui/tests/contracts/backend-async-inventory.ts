import { readdirSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

export const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../src")
export const architecture = resolve(sourceRoot, "../../../dev-docs/architecture.md")
export const manifestPath = resolve(sourceRoot, "../../../scripts/backend-async-operations.json")

export interface Classification { lifetime: string; families: string; authority: string }
export type Manifest = Record<string, string[]>

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

type Invocation = ts.CallExpression | ts.NewExpression
const normalized = (file: string) => file.replace(/\\/g, "/")
const externalOrigins = new Set(["https://api.github.com", "https://raw.githubusercontent.com"])

// Resolve declarations, not local spellings: aliases and destructured SDK methods
// retain the same identity. Only these adapter contracts constitute boundaries.
function boundary(node: Invocation, checker: ts.TypeChecker): string | undefined {
  const declaration = checker.getResolvedSignature(node)?.declaration
  if (!declaration) return
  const path = normalized(declaration.getSourceFile().fileName)
  const name = ("name" in declaration ? declaration.name?.getText() : undefined)
    ?? (ts.isPropertyAssignment(declaration.parent) ? declaration.parent.name.getText() : "")
  if (/\/typescript\/lib\/lib\.(?:dom|webworker).*\.d\.ts$|\/@types\/node\/web-globals\//.test(path)) {
    if (ts.isPropertyAccessExpression(node.expression) && name === "addEventListener") {
      const receiver = checker.getNonNullableType(checker.getTypeAtLocation(node.expression.expression)).symbol?.name
      if (receiver && /^(EventSource|WebSocket|XMLHttpRequest)$/.test(receiver)) return `network:${receiver}.${name}`
    }
    if (/^(fetch|sendBeacon|open|send)$/.test(name)) {
      if (name === "fetch" && node.arguments?.[0]) {
        const target = checker.getTypeAtLocation(node.arguments[0])
        if (target.isStringLiteral()) {
          try { if (externalOrigins.has(new URL(target.value).origin)) return } catch { /* Relative/dynamic targets require review. */ }
        }
      }
      const owner = declaration.parent && "name" in declaration.parent
        ? (declaration.parent.name as ts.Node | undefined)?.getText() : ""
      if (name === "fetch" || name === "sendBeacon" || /XMLHttpRequest|WebSocket/.test(owner ?? "")) return `network:${owner ? `${owner}.` : ""}${name}`
    }
    if (ts.isNewExpression(node)) {
      const type = checker.getTypeAtLocation(node)
      const typeName = type.symbol?.name
      if (typeName && /^(EventSource|WebSocket|XMLHttpRequest)$/.test(typeName)) return `network:new ${typeName}`
    }
  }
  if (/\/@opencode\/client\//.test(path) && checker.getTypeAtLocation(node).getProperty("then")) {
    const parts: string[] = []
    for (let parent: ts.Node | undefined = declaration; parent && !ts.isSourceFile(parent); parent = parent.parent) {
      if (ts.isPropertySignature(parent) || ts.isMethodSignature(parent) || ts.isClassDeclaration(parent)) {
        if (parent.name) parts.unshift(parent.name.getText())
      }
    }
    return `sdk:${parts.join(".") || name || "request"}`
  }
  const adapter = /\/lib\/(api-client|integrations-api|panel-extensions-api|server-meta|backend-events|server-events|auth-recovery|backend-transport)\.ts$/.exec(path)?.[1]
  if (!adapter) return
  if (adapter === "backend-events" || adapter === "server-events") {
    if (/^(on|once|onOpen|onDetach|onDispose|onTransportStatus|subscribe)$/.test(name)) return `${adapter}:${name}`
  } else if (adapter === "auth-recovery") {
    if (name === "onRestored") return `${adapter}:${name}`
  } else if (adapter === "backend-transport") {
    if (name === "fetch") return "network:BackendHttp.fetch"
  } else if (ts.isMethodDeclaration(declaration)
    || ts.isFunctionDeclaration(declaration) && /^(fetch|request|getServerMeta)/.test(name)) return `${adapter}:${name}`
}

function callbacks(node: Invocation, checker: ts.TypeChecker): ts.Node[] {
  const declaration = checker.getResolvedSignature(node)?.declaration
  if (declaration && "name" in declaration && declaration.name?.getText() === "removeEventListener"
    && /\/typescript\/lib\//.test(normalized(declaration.getSourceFile().fileName))) return []
  return (node.arguments ?? []).flatMap(argument => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument) ? [argument]
    : checker.getNonNullableType(checker.getTypeAtLocation(argument)).getCallSignatures().flatMap(signature => signature.declaration ? [signature.declaration] : []))
}

function analyzer(checker: ts.TypeChecker) {
  const edges = new Map<ts.Node, Set<ts.Node>>()
  const live = new Set<ts.Node>()
  let dirty = false
  function inspect(node: ts.Node): void {
    if (edges.has(node)) return
    const dependencies = new Set<ts.Node>()
    edges.set(node, dependencies)
    dirty = true
    function visit(child: ts.Node) {
      if (child !== node && ts.isFunctionLike(child)) return
      if (ts.isCallExpression(child) || ts.isNewExpression(child)) {
        if (boundary(child, checker)) live.add(node)
        const declaration = checker.getResolvedSignature(child)?.declaration
        if (declaration && !declaration.getSourceFile().isDeclarationFile) dependencies.add(declaration)
        for (const callback of callbacks(child, checker)) if (!callback.getSourceFile().isDeclarationFile) dependencies.add(callback)
      }
      ts.forEachChild(child, visit)
    }
    visit(node)
    for (const dependency of dependencies) inspect(dependency)
  }
  return (node: ts.Node) => {
    inspect(node)
    // Fixed point handles recursive and mutually recursive delegated callbacks.
    let changed = dirty
    dirty = false
    while (changed) {
      changed = false
      for (const [owner, dependencies] of edges) if (!live.has(owner) && [...dependencies].some(dependency => live.has(dependency))) {
        live.add(owner)
        changed = true
      }
    }
    return live.has(node)
  }
}

const analyzers = new WeakMap<ts.TypeChecker, ReturnType<typeof analyzer>>()

export function scanOperations(file: string, text: string, source?: ts.SourceFile, checker?: ts.TypeChecker): string[] {
  if (!source || !checker) throw new Error("Backend inventory requires a typed program")
  let reachesBackend = analyzers.get(checker)
  if (!reachesBackend) analyzers.set(checker, reachesBackend = analyzer(checker))
  const counts = new Map<string, number>()
  function add(id: string) { counts.set(id, (counts.get(id) ?? 0) + 1) }
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const id = boundary(node, checker!)
      if (id) add(id)
      const declaration = checker!.getResolvedSignature(node)?.declaration
      if (!id && declaration && !declaration.getSourceFile().isDeclarationFile && reachesBackend!(declaration)) {
        // Aggregate delegated invocations by their IO effect, never UI helper names.
        add("delegated:backend")
      }
      // Callback registration/continuation matters only when it reaches IO.
      for (const callback of callbacks(node, checker!)) if (!callback.getSourceFile().isDeclarationFile && reachesBackend!(callback)) {
        const expression = node.expression
        const name = declaration?.getSourceFile().isDeclarationFile
          ? ("name" in declaration ? declaration.name?.getText() : undefined)
            ?? (ts.isPropertyAccessExpression(expression) ? expression.name.text : "callback")
          : id ?? "delegated"
        add(`continuation:${name}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([id, count]) => `${id} x${count}`)
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

// Candidate only: source review assigns the actual authority before acceptance.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const candidate = Object.entries(discoverOperations(inventoryProgram())).filter(([, operations]) => operations.length)
  process.stdout.write(`{\n${candidate.map(([file, operations]) => `  ${JSON.stringify(file)}: ${JSON.stringify(operations)}`).join(",\n")}\n}\n`)
}
