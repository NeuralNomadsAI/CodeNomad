import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import test from "node:test"
import ts from "typescript"
import { architecture, discoverOperations, inventoryProgram, manifestPath, parseInventory, requiresClassification,
  scanOperations, sourceRoot, type Manifest } from "../../tests/contracts/backend-async-inventory"

test("every UI backend/deferred-async file has a current authority or explicit exclusion", t => {
  const document = readFileSync(architecture, "utf8")
  const rows = parseInventory(document)
  const detected = discoverOperations(inventoryProgram())
  const paths = new Set(Object.keys(detected))
  const missing: string[] = []
  for (const [path, operations] of Object.entries(detected)) {
    if (operations.length && !rows.has(path)) missing.push(path)
  }
  assert.deepEqual(missing, [], "Classify backend/deferred async work in architecture.md")
  assert.deepEqual([...rows.keys()].filter(path => !paths.has(path)), [], "Remove stale inventory paths")
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest
  assert.deepEqual(Object.keys(manifest).sort(), [...rows.keys()].sort(), "Manifest and documented families must agree")
  for (const [file, classification] of rows) {
    assert.deepEqual(manifest[file].classification, classification, `Review authority changes: ${file}`)
    assert.equal(new Set(manifest[file].operations).size, manifest[file].operations.length, `Duplicate operation: ${file}`)
    assert.deepEqual(detected[file], manifest[file].operations, `Classify each new/removed operation: ${file}`)
  }
  t.diagnostic(`${paths.size} UI sources scanned; ${rows.size} explicitly classified files; ${Object.values(manifest).reduce((sum, file) => sum + file.operations.length, 0)} operations`)
  const categories = new Map<string, number>()
  for (const row of rows.values()) {
    const primary = row.lifetime.split("+")[0]
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

test("inventory table and operation identities accept both LF and CRLF", () => {
  const document = readFileSync(architecture, "utf8").replace(/\r\n/g, "\n")
  assert.deepEqual(parseInventory(document), parseInventory(document.replace(/\n/g, "\r\n")))
  const text = "async function read() {\n await fetch('/api/status')\n setTimeout(read, 1)\n}\n"
  assert.deepEqual(scanOperations("example.ts", text), scanOperations("example.ts", text.replace(/\n/g, "\r\n")))
  assert.deepEqual(scanOperations("example.ts", text), scanOperations("example.ts", `// shifted source\n\n${text}`))
  assert.throws(() => parseInventory(document.replace("<!-- backend-async-inventory:end -->",
    "| `App.tsx` | A | duplicate | duplicate |\n<!-- backend-async-inventory:end -->")), /duplicate inventory row/)
})

test("static operation comparison rejects the reviewer's new backend function inside session-api", () => {
  const file = "stores/session-api.ts"
  const original = readFileSync(resolve(sourceRoot, file), "utf8")
  const reviewed = (JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest)[file].operations
  const mutation = "\nasync function r4UnlistedBackendOperation(){await fetch('/api/workspaces/r4-new-operation');setTimeout(()=>fetch('/api/workspaces/r4-followup'),300)}"
  // Replace this source only in the real typed program; no production file is written.
  const program = inventoryProgram()
  const options = program.getCompilerOptions()
  const host = ts.createCompilerHost(options)
  const getSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
    resolve(name) === resolve(sourceRoot, file)
      ? ts.createSourceFile(name, original + mutation, languageVersion, true)
      : getSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile)
  const mutatedProgram = ts.createProgram(program.getRootFileNames(), options, host)
  const source = mutatedProgram.getSourceFile(resolve(sourceRoot, file))!
  const detected = scanOperations(file, source.text, source, mutatedProgram.getTypeChecker())
  assert.throws(() => assert.deepEqual(detected, reviewed), assert.AssertionError)
  const added = detected.filter(id => !reviewed.includes(id))
  for (const kind of ["async:function", "await:fetch()", "backend-call:fetch", "deferred:setTimeout"]) {
    assert.ok(added.some(id => id.includes("/r4UnlistedBackendOperation") && id.includes(`::${kind}`)), `${kind}: ${added}`)
  }
  assert.ok(added.some(id => id.includes("setTimeout:arg0::backend-call:fetch")), added.join("\n"))
})

test("operation comparison rejects new functions, timers and subscriptions in an existing context", () => {
  const baseline = "async function existing(){ await fetch('/api/workspaces') }"
  const reviewed = scanOperations("existing.ts", baseline)
  for (const mutated of [
    `${baseline}\nasync function added(){ await fetch('/api/new') }`,
    baseline.replace("await fetch", "setTimeout(() => {}, 300); await fetch"),
    baseline.replace("await fetch", "backendEvents.onOpen(() => {}); await fetch"),
  ]) assert.throws(() => assert.deepEqual(scanOperations("existing.ts", mutated), reviewed), assert.AssertionError)
  assert.ok(scanOperations("new-file.ts", "setTimeout(callback, 300)").length)
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
