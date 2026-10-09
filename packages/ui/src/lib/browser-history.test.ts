import assert from "node:assert/strict"
import { test } from "node:test"
import { BrowserHistoryJournal, parseBrowserHistory } from "./browser-history"

test("restored URLs traverse without replay, merge live native history and discard forward on a new visit", () => {
  const a = "https://example.com/a", b = "https://example.com/b", c = "https://example.com/c", d = "https://example.com/d"
  const journal = new BrowserHistoryJournal({ urls: [a, b, c], index: 1 })
  const first = { entries: [{ id: 10, url: b }], index: 0 }
  assert.deepEqual(journal.observe(first), { urls: [a, b, c], index: 1 })
  assert.deepEqual(journal.request(0, first), { id: undefined, url: a })
  assert.equal(journal.observe(first).index, 1, "stale read cannot complete a traversal")
  const second = { entries: [{ id: 10, url: b }, { id: 11, url: a }], index: 1 }
  assert.deepEqual(journal.observe(second), { urls: [a, b, c], index: 0 })
  assert.deepEqual(journal.request(1, second), { id: 10, url: b })
  assert.deepEqual(journal.observe({ ...second, index: 0 }), { urls: [a, b, c], index: 1 })
  assert.deepEqual(journal.observe({ entries: [{ id: 10, url: b }, { id: 12, url: d }], index: 1 }), { urls: [a, b, d], index: 2 })
  assert.deepEqual(journal.observe({ entries: [{ id: 10, url: b }, { id: 12, url: d }], index: 0 }), { urls: [a, b, d], index: 1 })
  assert.throws(() => journal.request(-1, first))
})

test("saved history is bounded and rejects credentials, unsafe schemes, invalid cursor and mismatched current page", () => {
  const url = "https://example.com/"
  const fallback = { urls: [url], index: 0 }
  for (const value of [{ urls: ["javascript:alert(1)"], index: 0 }, { urls: ["https://user:secret@example.com/"], index: 0 },
    { urls: [url], index: 2 }, { urls: ["https://other.example/"], index: 0 }, { urls: Array(33).fill(url), index: 0 }]) {
    assert.deepEqual(parseBrowserHistory(value, url), fallback)
  }
  assert.deepEqual(parseBrowserHistory(fallback, url), fallback)
})
