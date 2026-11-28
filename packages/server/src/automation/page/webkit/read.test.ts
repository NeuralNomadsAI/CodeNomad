import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { runInNewContext } from "node:vm"
import type { PageOperation } from "../protocol"

test("the WebKit reader refuses to resolve or scroll a recycled node without its document proof", () => {
  const source = readFileSync(new URL("./read.generated.js", import.meta.url), "utf8")
  function world() {
    let scrolls = 0
    let pagehide: (() => void) | undefined
    const root = {
      nodeType: 1, get ownerDocument(): object { return document }, isConnected: true, getRootNode: (): object => document,
      scrollIntoView() { scrolls++ },
    }
    const document = {
      nodeType: 9,
      defaultView: {
        addEventListener(name: string, listener: () => void) { if (name === "pagehide") pagehide = listener },
        getComputedStyle: () => ({ transform: "none", perspective: "none", getPropertyValue: () => "" }),
      },
      documentElement: root,
    }
    const run = runInNewContext(`(function(request){${source}\n})`, {
      document,
      MutationObserver: class { observe() {} takeRecords() { return [] } },
      DOMMatrix: class {
        is2D = true; a = 1; b = 0; c = 0; d = 1
        scale() { return this }
        multiply() { return this }
      },
    })
    return {
      send: (operation: PageOperation, expectedDocument?: string) =>
        JSON.parse(run(JSON.stringify({ ...operation, expectedDocument }))),
      hide: () => pagehide!(),
      get scrolls() { return scrolls },
    }
  }
  const a = world(), b = world()
  const root: PageOperation = { op: "call", function: "document-root", args: [] }
  const expected = a.send({ op: "checkpoint" }).document
  const current = b.send({ op: "checkpoint" }).document
  assert.notEqual(expected, current)
  const rootA = a.send(root, expected).result.handle
  const rootB = b.send(root, current).result.handle
  const node = Number(rootA.split(":").at(-1))
  assert.equal(node, Number(rootB.split(":").at(-1)))

  for (const proof of [expected, undefined]) {
    assert.equal(b.send({ op: "scroll-into-view", node }, proof).document, current)
    assert.equal(b.scrolls, 0)
    assert.deepEqual(b.send({ op: "resolve", node }, proof).result, {})
    assert.deepEqual(b.send({ op: "geometry", node }, proof).result, {})
  }
  assert.equal(b.send({ op: "resolve", node }, current).result.handle, rootB)
  b.send({ op: "scroll-into-view", node }, current)
  assert.equal(b.scrolls, 1)
  b.hide()
  assert.notEqual(b.send({ op: "scroll-into-view", node }, current).document, current)
  assert.equal(b.scrolls, 1)
})
