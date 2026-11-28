import assert from "node:assert/strict"
import { test } from "node:test"
import { createLayoutKeyboardTracker, hasKeyboardOcclusion, installKeyboardOffset, isTextEntry, keyboardInset } from "./keyboard-offset"

const stale = { innerHeight: 900, viewportHeight: 763, viewportOffsetTop: 0 }

test("a stale desktop visualViewport never reserves a keyboard band", () => {
  assert.equal(keyboardInset({ ...stale, coarsePointer: false, editing: true }), 0)
  assert.equal(keyboardInset({ ...stale, coarsePointer: false, editing: false }), 0)
})

test("touch devices reserve the keyboard inset only while editing text", () => {
  assert.equal(keyboardInset({ ...stale, coarsePointer: true, editing: false }), 0)
  assert.equal(keyboardInset({ ...stale, coarsePointer: true, editing: true }), 137)
  assert.equal(keyboardInset({ innerHeight: 800, viewportHeight: 500.6, viewportOffsetTop: 40, coarsePointer: true, editing: true }), 259)
  assert.equal(keyboardInset({ innerHeight: 800, viewportHeight: 900, viewportOffsetTop: 0, coarsePointer: true, editing: true }), 0)
})

test("text entry covers text inputs, textareas and contenteditable only", () => {
  assert.equal(isTextEntry({ tagName: "TEXTAREA" }), true)
  assert.equal(isTextEntry({ tagName: "INPUT", type: "search" }), true)
  assert.equal(isTextEntry({ tagName: "INPUT" }), true)
  assert.equal(isTextEntry({ tagName: "DIV", isContentEditable: true }), true)
  for (const type of ["checkbox", "button", "range"]) assert.equal(isTextEntry({ tagName: "INPUT", type }), false)
  assert.equal(isTextEntry({ tagName: "BUTTON" }), false)
  assert.equal(isTextEntry(null), false)
})

test("height loss diagnoses an unzoomed keyboard while pan does not determine the detection", () => {
  const viewport = { height: 520, offsetTop: 240, scale: 1 }
  const win = { innerHeight: 800, visualViewport: viewport, matchMedia: () => ({ matches: true }),
    document: { activeElement: { tagName: "TEXTAREA" } } } as unknown as Window
  assert.equal(hasKeyboardOcclusion(win), true)
  viewport.height = 800
  assert.equal(hasKeyboardOcclusion(win), false, "pure pan")
  viewport.height = 750
  assert.equal(hasKeyboardOcclusion(win), false, "browser chrome while focused")
  viewport.height = 520
  viewport.scale = 1.5
  assert.equal(hasKeyboardOcclusion(win), false, "zoom")
})

test("the offset is recomputed on window resize and focus changes, and removed on cleanup", () => {
  const listeners = new Map<string, () => void>()
  const target = (prefix: string) => ({ addEventListener: (type: string, fn: () => void) => listeners.set(`${prefix}:${type}`, fn),
    removeEventListener: (type: string) => listeners.delete(`${prefix}:${type}`) })
  const properties = new Map<string, string>()
  const frames: Array<() => void> = []
  const doc = { ...target("document"), activeElement: { tagName: "TEXTAREA" } as unknown, documentElement: { style: {
    setProperty: (name: string, value: string) => properties.set(name, value), removeProperty: (name: string) => properties.delete(name) } } }
  const media = { matches: true, ...target("media") }
  const vv = { height: 763, offsetTop: 0, scale: 1, ...target("viewport") }
  const win = { ...target("window"), innerHeight: 900, visualViewport: vv, document: doc, matchMedia: () => media,
    requestAnimationFrame: (fn: () => void) => frames.push(fn), cancelAnimationFrame: () => {} }
  const flush = () => { while (frames.length) frames.shift()!() }
  const dispose = installKeyboardOffset(win as unknown as Window)
  flush()
  assert.equal(properties.get("--keyboard-offset"), "137px")
  doc.activeElement = { tagName: "BUTTON" }
  listeners.get("document:focusout")!(); flush()
  assert.equal(properties.get("--keyboard-offset"), "0px")
  doc.activeElement = { tagName: "TEXTAREA" }; vv.height = 900
  listeners.get("window:resize")!(); flush()
  assert.equal(properties.get("--keyboard-offset"), "0px", "a window resize picks up the restored viewport")
  dispose()
  assert.equal(properties.has("--keyboard-offset"), false)
  assert.equal(listeners.size, 0)
})

test("a keyboard that shrinks the whole window (Firefox web app) is measured from the full height", () => {
  // Measured on a Firefox 160 installed web app: 845 px closed, 475 px open.
  const track = createLayoutKeyboardTracker()
  const active = { tagName: "TEXTAREA" }
  const win = { innerWidth: 400, innerHeight: 845, visualViewport: { scale: 1 }, matchMedia: () => ({ matches: true }),
    document: { activeElement: active } } as unknown as Window & { innerWidth: number; innerHeight: number }
  assert.equal(track(win), 0)
  win.innerHeight = 475
  assert.equal(track(win), 370)
  win.innerHeight = 800
  assert.equal(track(win), 0, "browser chrome")
  win.innerHeight = 475
  ;(win.document as { activeElement: unknown }).activeElement = null
  assert.equal(track(win), 0, "not editing")
  ;(win.document as { activeElement: unknown }).activeElement = active
  win.innerWidth = 845
  assert.equal(track(win), 0, "rotation starts from the new geometry")
  win.innerWidth = 400
  win.innerHeight = 845
  assert.equal(track(win), 0, "keyboard closed")
})