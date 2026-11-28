import assert from "node:assert/strict"
import { test } from "node:test"
import { Readable } from "node:stream"
import { PreviewBodyBudget, replacePreviewPrefix, previewBodyKind } from "./preview-body"

const from = "/previews/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const to = "/previews/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test("prefix replacement preserves surrounding legacy bytes and UTF-16 byte order", () => {
  const legacy = Buffer.from([0x93, 0xe9, 0x94])
  const body = (prefix: string) => Buffer.concat([legacy, Buffer.from(prefix), legacy])
  assert.deepEqual(replacePreviewPrefix(body(from), from, to, "text/html; charset=windows-1252"), body(to))
  const wide = (prefix: string) => Buffer.from(`\ufeff漢${prefix}é`, "utf16le").swap16()
  assert.deepEqual(replacePreviewPrefix(wide(from), from, to, "text/html"), wide(to))
  assert.equal(previewBodyKind("text/css; charset=iso-8859-1"), "css")
  assert.equal(previewBodyKind("application/octet-stream; name=javascript"), null)
  assert.equal(previewBodyKind("text/event-stream"), null)
})

test("a shared rewrite slot covers drain and is returned on success, oversize, and cancellation", async () => {
  const budget = new PreviewBodyBudget(1, 3, 15_000, 0)
  const body = (s = "abc") => new Response(s).body!
  const parent = new AbortController()
  const neverSend = async () => { assert.fail("rewrite must not publish") }
  const drained = deferred()
  const first = budget.run(body(), parent.signal, async bytes => { assert.equal(bytes.toString(), "abc"); await drained.promise })
  await assert.rejects(budget.run(body(), parent.signal, neverSend), /capacity/)
  drained.resolve()
  await first
  await assert.rejects(budget.run(body("abcd"), parent.signal, neverSend), /large/)
  let cancelled = false
  const reading = deferred()
  const pending = budget.run(new ReadableStream({
    pull() { reading.resolve() },
    cancel() { cancelled = true },
  }, { highWaterMark: 0 }), parent.signal, neverSend)
  await reading.promise
  parent.abort()
  await assert.rejects(pending, { name: "AbortError" })
  assert.equal(cancelled, true)
  await budget.run(body(), new AbortController().signal, async () => {})
})

test("JavaScript MIME essences match the browser list, not names or parameters containing script", () => {
  for (const suffix of ["ecmascript", "javascript", "x-ecmascript", "x-javascript"]) {
    assert.equal(previewBodyKind(` Application/${suffix}; charset=utf-8`), "js")
    assert.equal(previewBodyKind(`text/${suffix}`), "js")
  }
  for (const suffix of ["jscript", "livescript", ...Array.from({ length: 6 }, (_, i) => `javascript1.${i}`)]) {
    assert.equal(previewBodyKind(`text/${suffix}`), "js")
  }
  for (const type of ["text/javascript1.6", "application/livescript", "text/js", "text/javascript-extra",
    "application/octet-stream; name=javascript", "text/javascript, text/plain"]) {
    assert.equal(previewBodyKind(type), null)
  }
})

test("paused rewrites receive slots in order; queue overflow and cancellation leave input unopened", async () => {
  const budget = new PreviewBodyBudget(1, 3, 15_000, 2)
  const parent = new AbortController()
  const cancelled = new AbortController()
  const opens: string[] = []
  const input = (id: string) => () => { opens.push(id); return Readable.from([Buffer.from(id)]) }
  const drain = deferred()
  const seen = deferred()
  const first = budget.run(input("a"), parent.signal, async () => { seen.resolve(); await drain.promise })
  await seen.promise
  const second = budget.run(input("b"), cancelled.signal, async () => assert.fail("cancelled input published"))
  const third = budget.run(input("c"), parent.signal, async () => {})
  await assert.rejects(budget.run(input("d"), parent.signal, async () => {}), /capacity/)
  cancelled.abort()
  await assert.rejects(second, { name: "AbortError" })
  const last = budget.run(input("e"), parent.signal, async () => {})
  assert.deepEqual(opens, ["a"])
  drain.resolve()
  await Promise.all([first, third, last])
  assert.deepEqual(opens, ["a", "c", "e"])
})

test("time spent waiting counts toward the same rewrite deadline", async () => {
  const budget = new PreviewBodyBudget(1, 3, 30)
  const parent = new AbortController()
  const entered = deferred()
  const release = deferred()
  const watchdog = setTimeout(() => parent.abort(new Error("Test stalled")), 2_000)
  const first = budget.run(new Response("a").body!, parent.signal, async () => {
    entered.resolve()
    await release.promise
  })
  try {
    await entered.promise
    await assert.rejects(budget.run(() => assert.fail("expired input opened"), parent.signal, async () => {}),
      { name: "AbortError" })
    assert.equal(parent.signal.aborted, false)
  } finally {
    release.resolve()
    await first
    clearTimeout(watchdog)
  }
})

test("a stalled source is cancelled at the rewrite deadline and releases capacity", async () => {
  const budget = new PreviewBodyBudget(1, 3, 5)
  const controller = new AbortController()
  let cancelled = false
  const watchdog = setTimeout(() => controller.abort(new Error("Test stalled")), 2_000)
  try {
    await assert.rejects(budget.run(new ReadableStream({ cancel() { cancelled = true } }), controller.signal,
      async () => { assert.fail("rewrite must not publish") }), { name: "AbortError" })
    assert.equal(controller.signal.aborted, false)
    assert.equal(cancelled, true)
    await budget.run(new Response("ok").body!, controller.signal, async () => {})
  } finally { clearTimeout(watchdog) }
})
