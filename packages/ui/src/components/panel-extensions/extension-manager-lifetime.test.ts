import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import ts from "typescript"

const source = ts.createSourceFile("extension-manager.tsx", readFileSync(new URL("./extension-manager.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
// Extract actual local action functions, leaving JSX and application singletons
// outside the test. Imports and view state are the injected dependencies.
function action(name: string, dependencies: Record<string, unknown>) {
  let initializer: ts.Expression | undefined
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) initializer = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(initializer, name)
  const code = ts.transpileModule(`return (${initializer.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return new Function(...Object.keys(dependencies), code)(...Object.values(dependencies))
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

test("extension administration retains admitted installs but never reacquires an old runtime refresh", async () => {
  const result = deferred<void>()
  let attached = true, busy = false, refreshes = 0, failures = 0, finishes = 0
  const run = action("run", {
    disposed: false, busy: () => busy, setBusy: (value: boolean) => { busy = value }, setFailed: (value: boolean) => { if (value) failures++ },
    props: { controller: { captureOperation: () => ({ current: () => attached }), refresh: async () => { refreshes++ } } },
  })
  const pending = run(async () => { await result.promise; finishes++ })
  attached = false; result.resolve(); await pending
  assert.equal(finishes, 1, "the client-owned mutation keeps its outcome")
  assert.equal(refreshes, 0); assert.equal(failures, 0); assert.equal(busy, false)
})

test("extension ZIP preparation rechecks the view after FileReader before backend inspection", async () => {
  let inspections = 0, finish!: () => void
  class FileReader {
    result = "data:application/zip;base64,ZIP"
    onload?: () => void
    readAsDataURL() { finish = () => this.onload?.() }
  }
  const dependencies = { busy: () => false, setPreview: () => {}, setAcknowledged: () => {},
    run: async (work: () => Promise<void>) => work(), PANEL_EXTENSION_LIMITS: { archiveBytes: 100 }, FileReader,
    panelExtensionsApi: { inspect: async () => { inspections++; return {} } },
    props: { controller: { entries: () => [] } },
  }
  const names = Object.keys(dependencies)
  let initializer: ts.Expression | undefined
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "inspect") initializer = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(source); assert.ok(initializer)
  const code = ts.transpileModule(`let disposed = false, reader; const inspect = ${initializer.getText(source)};
    return { inspect, close: () => { disposed = true } }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const view = new Function(...names, code)(...Object.values(dependencies))
  const pending = view.inspect({ size: 1 })
  view.close(); finish(); await pending
  assert.equal(inspections, 0)
})

test("extension install/remove handlers reject missing consent and a changed package digest", async () => {
  let runs = 0
  const selected = { manifest: { id: "extension" }, digest: "old", source: { kind: "catalog" } }
  const run = () => { runs++ }
  const install = action("install", { preview: () => selected, acknowledged: () => false, props: { controller: { verified: () => true } }, run })
  install(); assert.equal(runs, 0)
  const remove = action("remove", { removal: () => ({ id: "extension", digest: "old" }), run,
    props: { controller: { entries: () => [{ manifest: { id: "extension" }, digest: "new" }] } },
  })
  remove(); assert.equal(runs, 0)
})
