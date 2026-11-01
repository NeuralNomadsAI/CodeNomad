import assert from "node:assert/strict"
import { test } from "node:test"
import { createBundlesDocsOpener } from "./bundles-docs-opener"
import { openExternalUrl } from "../../lib/external-url"
import { PanelExtensionBusyError } from "../../lib/panel-extensions-api"
import { pinnedBlenderCatalog } from "../../../../server/src/opencode/integrations/catalog-pinned-fixture"

const url = pinnedBlenderCatalog().integrations[0]!.docs
const ready = async () => ({ outcome: "ready" as const, url })
test("single opening slot spans resolution/handoff and persistent 999/1000-ms dispatch interval", async () => {
  let at = 0, live = true, calls = 0, release!: (value: boolean) => void
  const opener = createBundlesDocsOpener(async (target, _context, current) => {
    assert.equal(target, url); assert(current!()); calls++
    return new Promise(resolve => { release = resolve })
  }, () => at)
  const first = opener("blender", ready, () => live)
  await Promise.resolve()
  assert.deepEqual(await opener("blender", ready, () => true), { outcome: "busy" })
  live = false; at = 20_000
  assert.deepEqual(await opener("blender", ready, () => true), { outcome: "busy" }, "deadline/remount cannot release an unresolved opener")
  release(true); assert.deepEqual(await first, { outcome: "unavailable" })
  live = true
  const second = opener("blender", ready, () => live); await Promise.resolve(); release(true)
  assert.deepEqual(await second, { outcome: "requested" })
  at += 999; assert.deepEqual(await opener("blender", ready, () => true), { outcome: "busy" })
  at++; const third = opener("blender", ready, () => true); await Promise.resolve(); release(false)
  assert.deepEqual(await third, { outcome: "unavailable" }); assert.equal(calls, 3)
})
test("invalid destinations, resolver failures and revoked continuations never invoke an opener", async () => {
  let calls = 0, live = true, resume!: () => void
  const opener = createBundlesDocsOpener(async () => { calls++; return true })
  assert.deepEqual(await opener("other", ready, () => true), { outcome: "unavailable" })
  for (const hostile of [url.replace("/blender/", "/houdini/"), url.replace("/opencode-integrations/", "/other/"),
    url.replace("/plugin/README.md", "/README.md"), url.replace("github.com", "evil.test"),
    url.replace("github.com", "github.com:443"), url.replace("blender/", "%62lender/"),
    url.replace("/plugin/", "/x/../plugin/"), `${url}?`, `${url}#`]) {
    assert.deepEqual(await opener("blender", async () => ({ outcome: "ready", url: hostile }), () => true), { outcome: "unavailable" })
  }
  for (const outcome of ["invalid", "unavailable", "busy"] as const) assert.deepEqual(await opener("blender", async () => ({ outcome }), () => true), { outcome })
  assert.deepEqual(await opener("blender", async () => { throw new PanelExtensionBusyError() }, () => true), { outcome: "busy" })
  assert.deepEqual(await opener("blender", async () => { throw new Error("PRIVATE_DOCS_SENTINEL") }, () => true), { outcome: "unavailable" })
  const pending = opener("blender", async () => { await new Promise<void>(resolve => { resume = resolve }); return ready() }, () => live)
  live = false; resume(); assert.deepEqual(await pending, { outcome: "unavailable" }); assert.equal(calls, 0)
})
test("actual web opener null popup result means requested handoff, never opened confirmation or retry", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window"), targets: unknown[] = []
  Object.defineProperty(globalThis, "window", { configurable: true, value: { open(...args: unknown[]) { targets.push(args); return null } } })
  try {
    const opener = createBundlesDocsOpener(openExternalUrl)
    assert.deepEqual(await opener("blender", ready, () => true), { outcome: "requested" })
    assert.deepEqual(targets, [[url, "_blank", "noopener,noreferrer"]])
    assert.deepEqual(await openExternalUrl(url, "test", () => false), false)
    assert.equal(targets.length, 1)
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous)
    else Reflect.deleteProperty(globalThis, "window")
  }
})
