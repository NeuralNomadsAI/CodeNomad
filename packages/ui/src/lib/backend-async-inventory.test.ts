import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, extname, resolve } from "node:path"
import test from "node:test"
import { isDeepStrictEqual } from "node:util"
import ts from "typescript"
import { architecture, discoverOperations, inventoryProgram, manifestPath, parseInventory,
  scanOperations, sourceRoot, type Manifest } from "../../tests/contracts/backend-async-inventory"

const document = readFileSync(architecture, "utf8")
const rows = parseInventory(document)
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest
let baseline: ts.Program | undefined
const baselineProgram = () => baseline ??= inventoryProgram()
const variants = new Map<string, string>()
let variantProgram: ts.Program | undefined

// All variants are registered before tests run. Sibling paths preserve relative
// imports; export {} isolates local names between otherwise-script fixtures.
function fixture(text: string, filename = "inventory-virtual.tsx"): string {
  assert.equal(variantProgram, undefined, "Register every variant before creating its shared program")
  const file = resolve(dirname(resolve(sourceRoot, filename)), `__backend_inventory_${variants.size}${extname(filename)}`)
  variants.set(file, text)
  return file
}

function scan(file: string): string[] {
  if (!variantProgram) {
    const original = baselineProgram()
    const options = original.getCompilerOptions()
    const host = ts.createCompilerHost(options)
    const get = host.getSourceFile.bind(host)
    host.getSourceFile = (name, version, error, fresh) => {
      const text = variants.get(resolve(name))
      return text !== undefined ? ts.createSourceFile(name, `${text}${text.includes("\r\n") ? "\r\n" : "\n"}export {}`, version, true)
        : original.getSourceFile(name) ?? get(name, version, error, fresh)
    }
    variantProgram = ts.createProgram({ rootNames: [...original.getRootFileNames(), ...variants.keys()],
      options, host, oldProgram: original })
  }
  const source = variantProgram.getSourceFile(file)!
  assert.deepEqual(variantProgram.getSyntacticDiagnostics(source), [], `Valid in-memory source: ${file}`)
  return scanOperations(source, variantProgram.getTypeChecker())
}

const positive = [
  "const {fetch: renamed} = globalThis; renamed('/api/status')",
  "new WebSocket('ws://localhost')", "new EventSource('/api/events')", "new XMLHttpRequest()",
  "declare const endpoint: string; fetch(endpoint)", "fetch('https://example.org/api')",
].map(text => ({ text, file: fixture(text) }))
const local = [
  "Promise.resolve().then(() => navigator.clipboard.writeText('text'))",
  "requestAnimationFrame(() => document.body.focus())",
  "new EventTarget().addEventListener('custom', () => {}); const native = { onDispose() {} }; native.onDispose()",
  "const endpoint = 'https://api.github.com/repos/example'; setTimeout(() => fetch(endpoint), 1)",
  "fetch('https://raw.githubusercontent.com/example/repo/main/file')",
].map(text => ({ text, file: fixture(text) }))
const delegatedTimer = fixture(`
  function follow() { return read() }
  function read() { return Math.random() ? fetch('/api') : follow() }
  const renamed = follow
  setTimeout(renamed, 1)
`)
const aliasedApi = fixture("import { serverApi as api } from './lib/api-client'; const renamed = api.fetchWorkspaces; renamed()")
const subscription = fixture("import { backendEvents as bus } from './lib/backend-events'; const renamed = bus.forInstance(() => 'local').onOpen; renamed(() => {})")
const disposal = fixture("import type { ServerEvents as Source } from './lib/server-events'; declare const source: Pick<Source, 'onDispose'>; const { onDispose: renamed } = source; renamed(() => {})")
const restored = fixture("import { authRecovery as recovery } from './lib/auth-recovery'; const renamed = recovery.onRestored; renamed(() => {})")
const guards = fixture("import { captureBackendOperation as capture } from './lib/backend-operation'; const op = capture('local'); op.current(); op.signal.throwIfAborted()")
const lineEndings = "async function read() {\n await fetch('/api/status')\n setTimeout(read, 1)\n}\n"
const lf = fixture(lineEndings)
const crlf = fixture(lineEndings.replace(/\n/g, "\r\n"))
const shifted = fixture(`// shifted source\n\n${lineEndings}`)

const sessionFile = "stores/session-api.ts"
const changedSession = resolve(sourceRoot, sessionFile)
const session = readFileSync(changedSession, "utf8")
const localTimer = fixture(`${session}\nsetTimeout(() => document.body.focus(), 300)`, sessionFile)
variants.set(changedSession, `${session}
  async function readUnlistedWorkspace() {
    await fetch("/api/workspaces/new")
    setTimeout(readUnlistedWorkspace, 300)
  }
`)
const importedDelegated = fixture("import { fetchSessions as renamed } from './stores/session-api'; renamed('local')")

const clipboardFile = "lib/clipboard.ts"
const clipboard = readFileSync(resolve(sourceRoot, clipboardFile), "utf8")
const localClipboard = `${clipboard}\nasync function copyExample() {\n await navigator.clipboard.writeText("example")\n}`
const clipboardWithLocalWork = fixture(localClipboard, clipboardFile)
const clipboardWithIo = fixture(`${localClipboard}\nfetch("/api/workspaces")`, clipboardFile)

test("every UI backend boundary has a reviewed authority", () => {
  const detected = Object.fromEntries(Object.entries(discoverOperations(baselineProgram())).filter(([, operations]) => operations.length))
  const files = new Set([...Object.keys(detected), ...Object.keys(manifest)])
  const changed = [...files].filter(file => !isDeepStrictEqual(detected[file], manifest[file])).sort()
  assert.deepEqual(changed, [], "Review changed backend accesses using the scanner's candidate output")
  assert.deepEqual([...rows.keys()].sort(), Object.keys(detected).sort(), "Document backend ownership in architecture.md")
})

test("typed network aliases and delegated continuations are classified, pure local work is free", () => {
  for (const { text, file } of positive) assert.ok(scan(file).length, text)
  for (const { text, file } of local) assert.deepEqual(scan(file), [], text)
  assert.ok(scan(delegatedTimer).includes("continuation:setTimeout x1"))
  assert.ok(scan(aliasedApi).includes("api-client:fetchWorkspaces x1"), scan(aliasedApi).join("\n"))
  assert.ok(scan(subscription).includes("backend-events:onOpen x1"), scan(subscription).join("\n"))
  assert.deepEqual(scan(disposal), ["server-events:onDispose x1"])
  assert.deepEqual(scan(restored), ["auth-recovery:onRestored x1"])
  assert.deepEqual(scan(guards), [])
  assert.ok(scan(importedDelegated).includes("delegated:backend x1"))
})

test("inventory table and operation identities accept both LF and CRLF", () => {
  const lfDocument = document.replace(/\r\n/g, "\n")
  assert.deepEqual(parseInventory(lfDocument), parseInventory(lfDocument.replace(/\n/g, "\r\n")))
  assert.deepEqual(scan(lf), scan(crlf))
  assert.deepEqual(scan(lf), scan(shifted))
  assert.throws(() => parseInventory(document.replace("<!-- backend-async-inventory:end -->",
    "| `App.tsx` | A | duplicate | duplicate |\n<!-- backend-async-inventory:end -->")), /duplicate inventory row/)
})

test("the inventory detects added backend work without counting local UI work", () => {
  const reviewed = manifest[sessionFile]
  const detected = scan(changedSession)
  assert.deepEqual(scan(localTimer), reviewed)
  assert.ok(detected.some(id => id.startsWith("network:") && !reviewed.includes(id)))
  assert.ok(detected.some(id => id.startsWith("continuation:setTimeout") && !reviewed.includes(id)))
  assert.deepEqual(scan(clipboardWithLocalWork), [])
  assert.deepEqual(scan(clipboardWithIo), ["network:fetch x1"])
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
