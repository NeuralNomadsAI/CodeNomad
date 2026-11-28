import assert from "node:assert/strict"
import { test } from "node:test"
import { productionHandler } from "../../../tests/test-support/production-ast"
import { deferred } from "../../../tests/test-support/deferred"

const source = new URL("./extension-manager.tsx", import.meta.url)
function action(name: string, dependencies: Record<string, unknown>) {
  return productionHandler(source, name, dependencies)
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
  const dependencies = { disposed: false, reader: undefined, busy: () => false, setPreview: () => {}, setAcknowledged: () => {},
    run: async (work: () => Promise<void>) => work(), PANEL_EXTENSION_LIMITS: { archiveBytes: 100 }, FileReader,
    panelExtensionsApi: { inspect: async () => { inspections++; return {} } },
    props: { controller: { entries: () => [] } },
  }
  const pending = action("inspect", dependencies)({ size: 1 })
  dependencies.disposed = true; finish(); await pending
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
