import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import ts from "typescript"

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const architecture = resolve(sourceRoot, "../../../dev-docs/architecture.md")
const backendNames = /^(?:fetch|fetcher|fetchImpl|serverApi|backendOf|OpenCodeClients|sdkManager|authenticatedFetch|captureBackendOperation|backendEvents|serverEvents|getRootClient|getSessionClient|EventSource|WebSocket|XMLHttpRequest|sendBeacon|toolImageSource|Image|Audio)$/
const deferredCall = /(?:^|\.)(?:setTimeout|setInterval|queueMicrotask|requestAnimationFrame|then|catch|finally)$/
const backendImport = /(?:api-client|server-events|backend-events|backend-client|backend-operation|sdk-manager|opencode-client|integrations-api|panel-extensions-api)$/

// Scan syntax rather than grep comments, translations or stringified examples.
// Include non-async wrappers, imported callbacks and timer-only consumers.
function requiresClassification(file: string, text: string, checkedSource?: ts.SourceFile, checker?: ts.TypeChecker): boolean {
  const source = checkedSource ?? ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  let found = false
  const promiseLike = (type: ts.Type): boolean => type.isUnion()
    ? type.types.some(promiseLike) : !!type.getProperty("then")
  function visit(node: ts.Node) {
    if (ts.isAwaitExpression(node)
      || ts.isNewExpression(node) && node.expression.getText(source) === "Promise"
      || ts.isFunctionLike(node) && ts.canHaveModifiers(node)
        && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)
      || ts.isIdentifier(node) && backendNames.test(node.text)
      || (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
        && /^(?:img|iframe|audio|video|source|embed|object)$/.test(node.tagName.getText(source))
      || ts.isBinaryExpression(node) && ts.isPropertyAccessExpression(node.left) && node.left.name.text === "src"
      || ts.isCallExpression(node) && deferredCall.test(node.expression.getText(source))
      || checker && ts.isCallExpression(node) && promiseLike(checker.getTypeAtLocation(node))
      || checker && node.parent && ts.isCallExpression(node.parent)
        && node.parent.arguments.some(argument => argument === node)
        && checker.getNonNullableType(checker.getTypeAtLocation(node)).getCallSignatures()
          .some(signature => promiseLike(signature.getReturnType()))
      || ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly
        && ts.isStringLiteral(node.moduleSpecifier) && backendImport.test(node.moduleSpecifier.text)) found = true
    if (!found) ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? sources(path)
      : /\.tsx?$/.test(entry.name) && !/(?:\.test\.|\.d\.ts$)/.test(entry.name) ? [path] : []
  })
}

test("every UI backend/deferred-async file has a current authority or explicit exclusion", t => {
  const document = readFileSync(architecture, "utf8")
  const section = document.split("<!-- backend-async-inventory:start -->")[1]?.split("<!-- backend-async-inventory:end -->")[0]
  assert.ok(section, "architecture.md must contain the backend async inventory")
  const rows = new Map<string, string>()
  for (const line of section.split("\n")) {
    const row = /^\| (`.+`) \| (A|C|P|V|DOM|IPC|EXTERNAL|COMPUTE)(?:\+(A|C|P|V|DOM|IPC|EXTERNAL|COMPUTE))* \| (.+) \| (.+) \|$/.exec(line)
    if (!row) continue
    for (const match of row[1].matchAll(/`([^`]+\.(?:ts|tsx))`/g)) {
      assert.ok(!rows.has(match[1]), `duplicate inventory row: ${match[1]}`)
      rows.set(match[1], line)
    }
  }
  const files = sources(sourceRoot)
  const configFile = resolve(sourceRoot, "../tsconfig.json")
  const config = ts.readConfigFile(configFile, ts.sys.readFile)
  assert.equal(config.error, undefined)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configFile))
  const program = ts.createProgram(files, parsed.options)
  const checker = program.getTypeChecker()
  const paths = new Set(files.map(file => relative(sourceRoot, file).replace(/\\/g, "/")))
  const missing: string[] = []
  for (const file of files) {
    const path = relative(sourceRoot, file).replace(/\\/g, "/")
    if (requiresClassification(path, readFileSync(file, "utf8"), program.getSourceFile(file), checker)
      && !rows.has(path)) missing.push(path)
  }
  assert.deepEqual(missing, [], "Classify backend/deferred async work in architecture.md")
  assert.deepEqual([...rows.keys()].filter(path => !paths.has(path)), [], "Remove stale inventory paths")
  t.diagnostic(`${files.length} UI sources scanned; ${rows.size} explicitly classified files`)
  const categories = new Map<string, number>()
  for (const row of rows.values()) {
    const primary = row.split(" | ")[1].split("+")[0]
    categories.set(primary, (categories.get(primary) ?? 0) + 1)
  }
  t.diagnostic(`Primary file lifetimes: ${[...categories].sort().map(([name, count]) => `${name}=${count}`).join(", ")}`)
})

test("inventory discovery includes delegated work and explicit non-backend exclusions", () => {
  for (const source of [
    "async function read() { await arbitraryAlias() }",
    "const read = () => fetch('/api/status')",
    "import { serverApi as api } from './api-client'; const run = () => api.fetchWorkspaces()",
    "import { backendEvents as events } from './server-events'; events.onOpen(callback)",
    "import { backendEvents as bus } from './backend-events'; bus.onOpen(callback)",
    "setTimeout(callback, 300)",
    "work.then(publish)",
    "new Promise(resolve => invokeNative(resolve))",
    "requestAnimationFrame(measure)",
    "async function github() { return fetch('https://api.github.com') }",
    "const image = <img src={backendUrl} />",
    "image.src = backendUrl",
    "new WebSocket(endpoint)",
  ]) assert.ok(requiresClassification("example.tsx", source), source)
  assert.equal(requiresClassification("example.ts", '// fetch, async, setTimeout\nconst copy = "fetch"'), false)
})

test("typed discovery follows arbitrary delegated aliases, callbacks and optional promise returns", () => {
  for (const text of [
    "declare const renamed: () => { then: () => void }; renamed()",
    "declare const maybe: () => { then: () => void } | undefined; maybe()",
    "declare const jobs: { read: () => { then: () => void } }; declare function install(work: unknown): void; install(jobs.read)",
  ]) {
    const file = "inventory-virtual.ts"
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const host = ts.createCompilerHost({ noLib: true })
    host.getSourceFile = name => name === file ? source : undefined
    const program = ts.createProgram([file], { noLib: true, strictNullChecks: true }, host)
    assert.ok(requiresClassification(file, text, source, program.getTypeChecker()), text)
  }
})

test("every CodeNomad HTTP adapter method is named in the IO-authority table", () => {
  const text = readFileSync(resolve(sourceRoot, "lib/api-client.ts"), "utf8")
  const source = ts.createSourceFile("api-client.ts", text, ts.ScriptTarget.Latest, true)
  const document = readFileSync(architecture, "utf8").split("#### Transport method families and IO authority")[1]?.split("## Feature Ownership")[0]
  assert.ok(document, "transport method authority table must exist")
  const missing: string[] = []
  const signalMethods: string[] = []
  function visit(node: ts.Node) {
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      const method = new RegExp(`\\b${node.name.text}\\b`)
      const row = document!.split("\n").find(line => method.test(line.split("|")[2] ?? ""))
      if (!row) missing.push(node.name.text)
      if (node.parameters.some(parameter => /AbortSignal|MissionPanelReadScope/.test(parameter.getText(source)))
        && !/\bS\b|\bscope\b/.test(row?.split("|")[3] ?? "")) signalMethods.push(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.deepEqual(missing, [], "Name new HTTP methods and their IO lifetime")
  assert.deepEqual(signalMethods, [], "Classify exposed HTTP cancellation as S or scope (plus C for durable mutations)")
})
