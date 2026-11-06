import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, extname, resolve } from "node:path"
import test from "node:test"
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
  return scanOperations(file, source.text, source, variantProgram.getTypeChecker())
}

const positive = [
  "fetch('/api/status')", "const renamed = fetch; renamed('/api/status')",
  "const {fetch: renamed} = globalThis; renamed('/api/status')",
  "new WebSocket('ws://localhost')", "new EventSource('/api/events')", "new XMLHttpRequest()",
  "const read = () => fetch('/api/status'); setTimeout(read, 1)",
].map(text => ({ text, file: fixture(text) }))
const local = [
  "async function read() { await Promise.resolve() }", "setTimeout(() => {}, 300)",
  "Promise.resolve().then(() => navigator.clipboard.writeText('text'))",
  "requestAnimationFrame(() => document.body.focus())", "new Promise(resolve => resolve(1))",
  "new EventTarget().addEventListener('custom', () => {}); const native = { onDispose() {}, onRestored() {} }; native.onDispose(); native.onRestored()",
  "const endpoint = 'https://api.github.com/repos/example'; setTimeout(() => fetch(endpoint), 1)",
  "// fetch, async, setTimeout\nconst copy = 'fetch'",
].map(text => ({ text, file: fixture(text) }))
const delegatedTimer = fixture("function read(){ return fetch('/api') }; const renamed = read; setTimeout(renamed, 1)")
const aliasedApi = fixture("import { serverApi as api } from './lib/api-client'; const renamed = api.fetchWorkspaces; renamed()")
const subscription = fixture("import { backendEvents as bus } from './lib/backend-events'; const renamed = bus.forInstance(() => 'local').onOpen; renamed(() => {})")
const disposal = fixture("import type { ServerEvents as Source } from './lib/server-events'; declare const source: Pick<Source, 'onDispose'>; const { onDispose: renamed } = source; renamed(() => {})")
const restored = fixture("import { authRecovery as recovery } from './lib/auth-recovery'; const renamed = recovery.onRestored; renamed(() => {})")
const guards = fixture("import { captureBackendOperation as capture } from './lib/backend-operation'; const op = capture('local'); op.current(); op.signal.throwIfAborted()")
const external = ["stores/github-stars.ts", "lib/bug-report.ts"].map(file => {
  const original = readFileSync(resolve(sourceRoot, file), "utf8")
  const renamed = original.replace(/REPO_API_URL|TEMPLATE_SOURCE_URL/g, "externalEndpoint")
    + '\nsetTimeout(() => fetch("https://api.github.com/repos/example"), 1)'
  return { renamed: fixture(renamed, file), io: fixture(renamed + '\nfetch("/api/new-backend-access")', file) }
})
const lineEndings = "async function read() {\n await fetch('/api/status')\n setTimeout(read, 1)\n}\n"
const lf = fixture(lineEndings)
const crlf = fixture(lineEndings.replace(/\n/g, "\r\n"))
const shifted = fixture(`// shifted source\n\n${lineEndings}`)

const sessionFile = "stores/session-api.ts"
const changedSession = resolve(sourceRoot, sessionFile)
const mutation = '\nasync function r4UnlistedBackendOperation() { await fetch("/api/workspaces/r4-new-operation"); setTimeout(() => fetch("/api/workspaces/r4-followup"), 300) }\n'
// This real module alone is replaced in the shared typed program, never on disk.
variants.set(changedSession, readFileSync(changedSession, "utf8") + mutation)
const newFile = "lib/r4-unclassified-backend-probe.ts"
const newAccess = fixture('export async function r4UnclassifiedBackendProbe() { return await fetch("/api/workspaces/r4-probe") }\n', newFile)
const existingText = "async function existing(){ await fetch('/api/workspaces') }"
const existing = fixture(existingText)
const newIo = [
  `${existingText}\nasync function added(){ await fetch('/api/new') }`,
  existingText.replace("await fetch", "setTimeout(existing, 300); await fetch"),
].map(text => fixture(text))
const localTimer = fixture(existingText.replace("await fetch", "setTimeout(() => {}, 300); await fetch"))
const delegatedText = existingText + "\nexisting()"
const delegated = fixture(delegatedText)
const renamedDelegated = fixture(delegatedText.replace(/existing/g, "renamedBackendHelper"))
const importedDelegated = fixture("import { fetchSessions as renamed } from './stores/session-api'; renamed('local')")

const ordinaryCases: [string, (text: string) => string][] = [
  ["lib/live-clock.ts", text => text.replace(/acquire/g, "acquireTick")],
  ["components/search-highlights.ts", text => text.replace(/watchRowMoves/g, "observeRowMoves")],
  ["components/hidden-text.tsx", text => text.replace(/holdRevealAnchor/g, "retainRevealAnchor")],
  ["components/settings/settings-scroll-restoration.ts", text => text.replace(/viewport/g, "scrollViewport")],
  ["lib/clipboard.ts", text => text.replace("await navigator.clipboard.writeText(text)", "await Promise.resolve(); await navigator.clipboard.writeText(text)")],
  ["lib/clipboard.ts", text => text.replace("await navigator.clipboard.writeText(text)", "const clipboard = navigator.clipboard; await clipboard.writeText(text)")],
  ["components/reveal-focus.ts", text => text.replace("  target.focus({ preventScroll: true })", "  requestAnimationFrame(() => target.focus({ preventScroll: true }))")],
  ["lib/live-clock.ts", text => "// UI clock\n\n" + text.replace(/  /g, "    ")],
  ["lib/live-clock.ts", text => text.replace("TICK_MS = 1000", "TICK_MS = 500")],
  ["lib/live-clock.ts", text => text.replace(/subscribers/g, "consumers")],
]
const ordinary = ordinaryCases.map(([file, mutate]) => {
  const original = readFileSync(resolve(sourceRoot, file), "utf8")
  const changed = mutate(original)
  return { file, original, changed, before: fixture(original, file), after: fixture(changed, file),
    io: fixture(changed + '\nfetch("/api/new-backend-access")', file) }
})

test("every UI backend boundary has a reviewed authority", t => {
  const detected = discoverOperations(baselineProgram())
  const paths = new Set(Object.keys(detected))
  const missing: string[] = []
  for (const [path, operations] of Object.entries(detected)) {
    if (operations.length && !rows.has(path)) missing.push(path)
  }
  assert.deepEqual(missing, [], "Classify backend work in architecture.md")
  assert.deepEqual([...rows.keys()].filter(path => !paths.has(path)), [], "Remove stale inventory paths")
  assert.deepEqual([...rows.keys()].sort(), Object.keys(detected).filter(file => detected[file].length).sort(),
    "Document only backend-bearing files; generic helpers inherit their caller's owner")
  assert.deepEqual(Object.keys(manifest).sort(), Object.keys(detected).filter(file => detected[file].length).sort())
  for (const [file, operations] of Object.entries(manifest)) {
    assert.ok(rows.has(file), `Document backend ownership: ${file}`)
    assert.equal(new Set(operations).size, operations.length, `Duplicate boundary: ${file}`)
    assert.deepEqual(detected[file], operations, `Review new/removed backend accesses: ${file}`)
  }
  t.diagnostic(`${paths.size} UI sources scanned; ${Object.keys(manifest).length} boundary-bearing files; ${Object.values(manifest).reduce((sum, operations) => sum + operations.length, 0)} counted boundary/continuation identities`)
  const categories = new Map<string, number>()
  for (const row of rows.values()) {
    const primary = row.lifetime.split("+")[0]
    categories.set(primary, (categories.get(primary) ?? 0) + 1)
  }
  t.diagnostic(`Primary file lifetimes: ${[...categories].sort().map(([name, count]) => `${name}=${count}`).join(", ")}`)
})

test("typed network aliases and delegated continuations are classified, pure local work is free", t => {
  for (const { text, file } of positive) assert.ok(scan(file).length, text)
  for (const { text, file } of local) assert.deepEqual(scan(file), [], text)
  assert.ok(scan(delegatedTimer).includes("continuation:setTimeout x1"))
  assert.ok(scan(aliasedApi).includes("api-client:fetchWorkspaces x1"), scan(aliasedApi).join("\n"))
  assert.ok(scan(subscription).includes("backend-events:onOpen x1"), scan(subscription).join("\n"))
  assert.deepEqual(scan(disposal), ["server-events:onDispose x1"])
  assert.deepEqual(scan(restored), ["auth-recovery:onRestored x1"])
  assert.deepEqual(scan(guards), [])
  for (const { renamed, io } of external) {
    assert.deepEqual(scan(renamed), [])
    assert.ok(scan(io).length)
  }
  t.diagnostic(`${variants.size} in-memory variants share one program/checker and reuse baseline source ASTs`)
})

test("inventory table and operation identities accept both LF and CRLF", () => {
  const lfDocument = document.replace(/\r\n/g, "\n")
  assert.deepEqual(parseInventory(lfDocument), parseInventory(lfDocument.replace(/\n/g, "\r\n")))
  assert.deepEqual(scan(lf), scan(crlf))
  assert.deepEqual(scan(lf), scan(shifted))
  assert.throws(() => parseInventory(document.replace("<!-- backend-async-inventory:end -->",
    "| `App.tsx` | A | duplicate | duplicate |\n<!-- backend-async-inventory:end -->")), /duplicate inventory row/)
})

test("static operation comparison rejects the reviewer's new backend function inside session-api", () => {
  const reviewed = manifest[sessionFile]
  const detected = scan(changedSession)
  assert.throws(() => assert.deepEqual(detected, reviewed), assert.AssertionError)
  assert.ok(detected.some(id => id.startsWith("network:") && !reviewed.includes(id)))
  assert.ok(detected.some(id => id.startsWith("continuation:setTimeout") && !reviewed.includes(id)))
  assert.ok(scan(newAccess).length)
  assert.equal(rows.has(newFile), false)
  assert.throws(() => assert.deepEqual(scan(newAccess), manifest[newFile] ?? []), assert.AssertionError)
})

test("operation comparison rejects new IO and IO timers but permits unrelated timers", () => {
  const reviewed = scan(existing)
  for (const mutated of newIo) assert.throws(() => assert.deepEqual(scan(mutated), reviewed), assert.AssertionError)
  assert.deepEqual(scan(localTimer), reviewed)
  assert.throws(() => assert.deepEqual(scan(delegated), reviewed), assert.AssertionError)
  assert.deepEqual(scan(renamedDelegated), scan(delegated))
  assert.ok(scan(importedDelegated).includes("delegated:backend x1"))
})

test("reviewer's ten ordinary DOM transformations preserve the boundary inventory", () => {
  for (const { file, original, changed, before, after, io } of ordinary) {
    assert.equal(rows.has(file), false, `Pure module needs no table entry: ${file}`)
    assert.notEqual(changed, original, `Transformation must apply: ${file}`)
    assert.deepEqual(scan(after), scan(before), file)
    // A pure module still fails classification as soon as it acquires IO.
    assert.ok(scan(io).length, file)
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
