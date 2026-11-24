import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createRoot, createSignal } from "solid-js"
import { MESSAGE_HISTORY_TRAVERSAL_PAGE_LIMIT } from "../../message-history-pagination"
import { useTaskStepCopy } from "./task-copy"
import { copyTextChunksToClipboard, copyToClipboard } from "../../../lib/clipboard"
import { installClipboardFallbackDom } from "../../../lib/clipboard.test-fixture"

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve))

describe("task copy through the actual clipboard fallback chain", () => {
  for (const pendingStrategy of ["write", "writeText"] as const) {
    it(`does not overwrite a newer copy after cancelled ${pendingStrategy} rejects`, async () => {
      const gate = deferred()
      const writes: string[] = []
      let strategyStarted = false
      let execCalls = 0
      const state = installClipboardFallbackDom(() => { execCalls++; writes.push("stale execCommand"); return true }, {
        write: async () => {
          if (pendingStrategy === "write") { strategyStarted = true; return gate.promise }
          throw new Error("Try text clipboard")
        },
        writeText: async text => {
          if (text === "NEW USER COPY") { writes.push(text); return }
          strategyStarted = true
          return gate.promise
        },
      })
      const fixture = mount({ copy: copyTextChunksToClipboard })
      try {
        const oldCopy = fixture.copy()
        await tick()
        assert.equal(strategyStarted, true)
        if (pendingStrategy === "write") fixture.setActive(false)
        else fixture.dispose()
        assert.equal(await copyToClipboard("NEW USER COPY"), true)
        fixture.setActive(true)
        gate.reject(new Error("Clipboard permission lost"))
        await oldCopy
        assert.deepEqual(writes, ["NEW USER COPY"])
        assert.equal(execCalls, 0)
      } finally { gate.resolve(); fixture.dispose(); state.restore() }
    })
  }

  it("retains the complete output through both fallbacks while the owner is current", async () => {
    const strategies: string[] = []
    const state = installClipboardFallbackDom(() => { strategies.push("execCommand"); return true }, {
      write: async () => { strategies.push("write"); throw new Error("Use text") },
      writeText: async () => { strategies.push("writeText"); throw new Error("Use DOM") },
    })
    const fixture = mount({ copy: copyTextChunksToClipboard })
    try {
      await fixture.copy()
      assert.deepEqual(strategies, ["write", "writeText", "execCommand"])
      assert.deepEqual(JSON.parse(state.textArea.value), [{ type: "tool", output: "complete" }])
      assert.equal(state.removed(), true)
    } finally { fixture.dispose(); state.restore() }
  })
})

function mount(overrides: Partial<Parameters<typeof useTaskStepCopy>[0]> = {}) {
  const [active, setActive] = createSignal(true)
  const [child, setChild] = createSignal("child-a")
  const releases: number[] = []
  const acquisitions: string[] = []
  const clipboard: string[] = []
  const loads: Array<{ kind: string; id: string; signal: AbortSignal }> = []
  let dispose!: () => void
  const copy = createRoot(done => {
    dispose = done
    return useTaskStepCopy({
      childSessionId: child,
      isActive: active,
      beginTraversal: id => {
        const index = acquisitions.length
        acquisitions.push(id)
        return () => { releases.push(index) }
      },
      getPageKey: () => "latest",
      isLatest: () => true,
      readSteps: () => [{ type: "tool", output: "complete" }],
      copy: async chunks => { clipboard.push(chunks.join("")) },
      ...overrides,
      loadOldest: async (id, signal) => {
        loads.push({ kind: "oldest", id, signal })
        return overrides.loadOldest ? overrides.loadOldest(id, signal) : true
      },
      loadNewer: async (id, signal) => {
        loads.push({ kind: "newer", id, signal })
        return overrides.loadNewer ? overrides.loadNewer(id, signal) : true
      },
    })
  })
  return { ...copy, setActive, setChild, releases, acquisitions, clipboard, loads, dispose }
}

describe("full child task-step copy lifetime", () => {
  it("copies lossless output across replaced pages, beyond the rendered step/title limits", async () => {
    const pages = Array.from({ length: 3 }, (_, page) => Array.from({ length: 220 }, (_, index) => ({
      type: "tool", id: `${page}:${index}`, tool: "shell",
      state: { title: "長い title\n".repeat(500), output: `page ${page} step ${index}\n\u0000\"\\tail` },
    })))
    let resident: unknown[] = []
    let page = 0
    const fixture = mount({
      loadOldest: async () => { page = 0; resident = pages[page]; return true },
      loadNewer: async () => { resident = pages[++page]; return true },
      getPageKey: () => String(page),
      isLatest: () => page === pages.length - 1,
      readSteps: () => resident,
    })
    try {
      await fixture.copy()
      assert.deepEqual(JSON.parse(fixture.clipboard[0]), pages.flat())
      assert.equal(fixture.clipboard.length, 1)
      assert.deepEqual(fixture.loads.map(load => load.kind), ["oldest", "newer", "newer"])
      assert.ok(fixture.loads.every(load => load.signal === fixture.loads[0].signal))
      assert.deepEqual(fixture.releases, [0])
      assert.equal(fixture.pending(), false)
    } finally { fixture.dispose() }
  })

  for (const failedPage of ["oldest", "newer"] as const) {
    it(`does not visit an uncommitted ${failedPage} page or copy resident/partial data`, async () => {
      let visits = 0
      let residentIsLatest = failedPage === "oldest"
      const fixture = mount({
        loadOldest: async () => failedPage !== "oldest",
        loadNewer: async () => { residentIsLatest = true; return false },
        isLatest: () => residentIsLatest,
        readSteps: () => { visits++; return [{ output: "resident tail is not the complete history" }] },
      })
      try {
        await assert.rejects(fixture.copy(), /page was not committed/)
        assert.equal(visits, failedPage === "oldest" ? 0 : 1)
        assert.deepEqual(fixture.loads.map(load => load.kind), failedPage === "oldest" ? ["oldest"] : ["oldest", "newer"])
        assert.deepEqual(fixture.clipboard, [])
        assert.deepEqual(fixture.releases, [0])
        assert.equal(fixture.pending(), false)
      } finally { fixture.dispose() }
    })
  }

  it("coalesces repeated copies and keeps the lifetime through the clipboard callback", async () => {
    const gate = deferred(), clipboardGate = deferred()
    let writes = 0
    const fixture = mount({ loadOldest: () => gate.promise.then(() => true), copy: async () => { writes++; await clipboardGate.promise } })
    try {
      const first = fixture.copy()
      assert.equal(fixture.copy(), first)
      assert.equal(fixture.loads.length, 1)
      gate.resolve()
      await tick()
      assert.equal(writes, 1)
      assert.equal(fixture.pending(), true)
      assert.equal(fixture.copy(), first)
      clipboardGate.resolve()
      await first
      assert.deepEqual(fixture.releases, [0])
      assert.equal(fixture.pending(), false)
    } finally { gate.resolve(); clipboardGate.resolve(); fixture.dispose() }
  })

  it("aborts on deactivation and an old finally cannot release a returning view's copy", async () => {
    const gates = [deferred(), deferred()]
    let request = 0
    const fixture = mount({ loadOldest: () => gates[request++].promise.then(() => true) })
    try {
      const old = fixture.copy()
      fixture.setActive(false)
      assert.equal(fixture.loads[0].signal.aborted, true)
      assert.deepEqual(fixture.releases, [0], "release precedes cancelled loader settlement")
      fixture.setActive(true)
      const fresh = fixture.copy()
      gates[0].resolve()
      await old
      assert.equal(fixture.pending(), true)
      assert.equal(fixture.copy(), fresh)
      assert.deepEqual(fixture.releases, [0])
      assert.deepEqual(fixture.clipboard, [])
      assert.equal(fixture.loads[1].signal.aborted, false)
      gates[1].resolve()
      await fresh
      assert.equal(fixture.clipboard.length, 1)
      assert.deepEqual(fixture.releases, [0, 1])
    } finally { gates.forEach(gate => gate.resolve()); fixture.dispose() }
  })

  it("aborts child changes during newer-page loading and never resumes the old pagination", async () => {
    const gate = deferred()
    let page = 0
    const fixture = mount({
      getPageKey: () => String(page), isLatest: () => false,
      loadNewer: async () => { await gate.promise; page++; return true },
    })
    try {
      const copy = fixture.copy()
      await tick()
      assert.equal(fixture.loads.length, 2)
      fixture.setChild("child-b")
      assert.ok(fixture.loads.every(load => load.signal.aborted))
      assert.deepEqual(fixture.releases, [0])
      gate.resolve()
      await copy
      assert.equal(fixture.loads.length, 2)
      assert.deepEqual(fixture.clipboard, [])
    } finally { gate.resolve(); fixture.dispose() }
  })

  it("aborts on owner cleanup, suppresses abort rejection, and rejects later copy attempts", async () => {
    const gate = deferred()
    const fixture = mount({ loadOldest: () => gate.promise.then(() => true) })
    const copy = fixture.copy()
    fixture.dispose()
    assert.equal(fixture.loads[0].signal.aborted, true)
    assert.deepEqual(fixture.releases, [0])
    gate.reject(new DOMException("Aborted", "AbortError"))
    await copy
    await fixture.copy()
    assert.equal(fixture.loads.length, 1)
    assert.deepEqual(fixture.clipboard, [])
    assert.deepEqual(fixture.releases, [0])
  })

  it("cancels when the document becomes hidden, even while its session remains active", async () => {
    class VisibilityDocument extends EventTarget { visibilityState = "visible" }
    const visibility = new VisibilityDocument()
    const original = Object.getOwnPropertyDescriptor(globalThis, "document")
    Object.defineProperty(globalThis, "document", { configurable: true, value: visibility })
    const gate = deferred()
    const fixture = mount({ loadOldest: () => gate.promise.then(() => true) })
    try {
      const copy = fixture.copy()
      visibility.visibilityState = "hidden"
      visibility.dispatchEvent(new Event("visibilitychange"))
      assert.equal(fixture.loads[0].signal.aborted, true)
      assert.deepEqual(fixture.releases, [0])
      await fixture.copy()
      visibility.visibilityState = "visible"
      gate.resolve()
      await copy
      assert.equal(fixture.loads.length, 1, "showing the window does not revive or restart an explicit copy")
      assert.deepEqual(fixture.clipboard, [])
    } finally {
      gate.resolve()
      fixture.dispose()
      if (original) Object.defineProperty(globalThis, "document", original)
      else Reflect.deleteProperty(globalThis, "document")
    }
  })

  it("rechecks authority immediately before clipboard dispatch after the final page", async () => {
    let active = true
    const fixture = mount({
      isActive: () => active,
      readSteps: () => {
        // The last visit is synchronous; the completion continuation is async.
        // No reactive effect is available to save a missing final authority check.
        queueMicrotask(() => { active = false })
        return [{ output: "must not be copied" }]
      },
    })
    try {
      await fixture.copy()
      assert.deepEqual(fixture.clipboard, [])
      assert.deepEqual(fixture.releases, [0])
    } finally { fixture.dispose() }
  })

  it("fails closed at the traversal budget rather than copying a partial history", async () => {
    let page = 0
    const fixture = mount({
      getPageKey: () => String(page), isLatest: () => false,
      loadNewer: async () => { page++; return true },
    })
    try {
      await assert.rejects(fixture.copy(), /traversal page limit/)
      assert.equal(page, MESSAGE_HISTORY_TRAVERSAL_PAGE_LIMIT)
      assert.deepEqual(fixture.clipboard, [])
      assert.deepEqual(fixture.releases, [0])
      assert.equal(fixture.pending(), false)
    } finally { fixture.dispose() }
  })

  it("releases failed loaders and clipboard callbacks so an explicit retry can succeed", async () => {
    let failLoad = true, failCopy = true
    const fixture = mount({
      loadOldest: async () => { if (failLoad) throw new Error("load failed"); return true },
      copy: async () => { if (failCopy) throw new Error("clipboard failed") },
    })
    try {
      await assert.rejects(fixture.copy(), /load failed/)
      failLoad = false
      await assert.rejects(fixture.copy(), /clipboard failed/)
      failCopy = false
      await fixture.copy()
      assert.deepEqual(fixture.releases, [0, 1, 2])
      assert.equal(fixture.pending(), false)
    } finally { fixture.dispose() }
  })
})
