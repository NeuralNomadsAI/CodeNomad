import assert from "node:assert/strict"
import { test } from "node:test"
import { findNestedScroller } from "./scroll-gesture-routing.ts"

class FakeElement {
  overflowY = "visible"
  scrollTop = 0
  scrollHeight = 100
  clientHeight = 100
  scrollWidth = 100
  clientWidth = 100
  constructor(public parentElement: FakeElement | null = null) {}
}

test("the innermost nested scroller that can still move consumes the gesture", () => {
  const globals = globalThis as Record<string, unknown>
  const previous = { Element: globals.Element, HTMLElement: globals.HTMLElement, getComputedStyle: globals.getComputedStyle }
  let styleReads = 0
  Object.assign(globals, {
    Element: FakeElement,
    HTMLElement: FakeElement,
    getComputedStyle: (node: FakeElement) => { styleReads++; return { overflowX: "visible", overflowY: node.overflowY } },
  })
  try {
    const root = new FakeElement()
    const outer = Object.assign(new FakeElement(root), { overflowY: "auto", scrollHeight: 400 })
    // Overflowing content of a non-scroller still reports a larger scrollHeight.
    const visible = Object.assign(new FakeElement(outer), { scrollHeight: 300 })
    const inner = Object.assign(new FakeElement(visible), { overflowY: "scroll", scrollHeight: 300 })
    const target = new FakeElement(inner)
    const find = (node: unknown, direction: "up" | "down") =>
      findNestedScroller(root as unknown as HTMLElement, node as EventTarget, direction)

    assert.equal(find(target, "down"), inner)
    assert.equal(find(target, "up"), null, "Scrollers at their top pass an upward gesture to the root")
    inner.scrollTop = 200
    assert.equal(find(target, "down"), outer, "An exhausted scroller chains to its scrolling ancestor")
    assert.equal(find(target, "up"), inner)
    outer.scrollTop = 300
    assert.equal(find(target, "down"), null)
    assert.equal(find(root, "down"), null, "The root itself is never nested")
    assert.equal(find(null, "down"), null)

    styleReads = 0
    find(new FakeElement(new FakeElement(new FakeElement(root))), "down")
    assert.equal(styleReads, 0, "Ancestors that cannot move skip style resolution")
  } finally {
    Object.assign(globals, previous)
  }
})
