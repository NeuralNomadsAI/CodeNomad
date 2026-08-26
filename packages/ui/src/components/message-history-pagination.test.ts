import assert from "node:assert/strict"
import fs from "node:fs"
import { describe, it } from "node:test"
import { batch, createRoot, createSignal } from "solid-js"

import { createSearchLocatorAuthority, getMessageWindowPageKey, hasMessageSearchAuthority, isMessageHistoryRestoreCurrent, loadCompleteMessageHistory, loadMessageHistoryPage, loadPagesUntilAnchor, MESSAGE_HISTORY_TOP_THRESHOLD_PX, reconcileResidentSearchMatches, shouldLoadOlderMessages } from "./message-history-pagination.ts"

describe("message history pagination", () => {
  const ready = {
    active: true,
    failed: false,
    hasMore: true,
    loading: false,
    scrollTop: MESSAGE_HISTORY_TOP_THRESHOLD_PX,
  }

  it("loads at the top threshold", () => {
    assert.equal(shouldLoadOlderMessages(ready), true)
    assert.equal(shouldLoadOlderMessages({ ...ready, scrollTop: MESSAGE_HISTORY_TOP_THRESHOLD_PX + 1 }), false)
  })

  it("guards inactive, exhausted, concurrent, and failed loads", () => {
    assert.equal(shouldLoadOlderMessages({ ...ready, active: false }), false)
    assert.equal(shouldLoadOlderMessages({ ...ready, hasMore: false }), false)
    assert.equal(shouldLoadOlderMessages({ ...ready, loading: true }), false)
    assert.equal(shouldLoadOlderMessages({ ...ready, failed: true }), false)
  })

  it("follows native page authority until the anchor appears", async () => {
    let pages = 0
    const result = await loadPagesUntilAnchor({
      hasAnchor: () => pages === 2,
      hasMore: () => true,
      isCurrent: () => true,
      loadMore: async () => { pages += 1 },
    })

    assert.equal(result, "found")
    assert.equal(pages, 2)
  })

  it("stops when the native cursor exhausts or session authority changes", async () => {
    let pages = 0
    assert.equal(await loadPagesUntilAnchor({
      hasAnchor: () => false,
      hasMore: () => pages < 2,
      isCurrent: () => true,
      loadMore: async () => { pages += 1 },
    }), "exhausted")
    assert.equal(pages, 2)

    let current = true
    assert.equal(await loadPagesUntilAnchor({
      hasAnchor: () => false,
      hasMore: () => true,
      isCurrent: () => current,
      loadMore: async () => { current = false },
    }), "cancelled")
  })

  it("does not continue to a second page after locator authority resets", async () => {
    const authority = createSearchLocatorAuthority()
    const token = authority.claim("match")!
    let resolveFirst!: () => void
    const first = new Promise<void>((resolve) => { resolveFirst = resolve })
    let pages = 0
    const result = loadPagesUntilAnchor({
      hasAnchor: () => false,
      hasMore: () => true,
      isCurrent: () => authority.isCurrent(token),
      loadMore: async () => {
        pages += 1
        if (pages === 1) await first
      },
    })

    authority.reset(token)
    resolveFirst()

    assert.equal(await result, "cancelled")
    assert.equal(pages, 1)
  })

  it("invalidates anchor restore when the view deactivates or replaces its list", () => {
    const capturedList = {}
    assert.equal(isMessageHistoryRestoreCurrent(true, capturedList, capturedList, true), true)
    assert.equal(isMessageHistoryRestoreCurrent(false, capturedList, capturedList, true), false)
    assert.equal(isMessageHistoryRestoreCurrent(true, capturedList, {}, true), false)
    assert.equal(isMessageHistoryRestoreCurrent(true, capturedList, capturedList, false), false)
  })

  it("resets virtual measurements only when the resident page changes", () => {
    const latest = { kind: "latest", newerCursors: [] }
    const older = { kind: "history", resumeCursor: "older", newerCursors: ["newer"] }
    const next = { kind: "history", resumeCursor: "newer", newerCursors: [null] }

    assert.equal(getMessageWindowPageKey(latest), getMessageWindowPageKey({ ...latest }))
    assert.notEqual(getMessageWindowPageKey(latest), getMessageWindowPageKey(older))
    assert.notEqual(getMessageWindowPageKey(older), getMessageWindowPageKey(next))
  })

  it("keeps follow escaped after positioning an older resident page", () => {
    const source = fs.readFileSync(new URL("./message-section.tsx", import.meta.url), "utf8")
    const start = source.indexOf("async function pageWindow(")
    const paging = source.slice(start, source.indexOf("function messageWindowPageKey", start))
    const position = paging.indexOf("after(api)")

    assert.ok(position >= 0)
    assert.ok(paging.indexOf('api.setAutoScroll(direction === "latest")', position) > position)
  })

  it("keeps native inbox prompts after delivered transcript messages", () => {
    const source = fs.readFileSync(new URL("./message-section.tsx", import.meta.url), "utf8")
    const start = source.indexOf("const visibleMessageIds")
    const projection = source.slice(start, source.indexOf("const sessionRevision", start))

    assert.match(projection, /visible\.filter\(\(messageId\) => !props\.pendingPrompts!\.has\(messageId\)\)/)
    assert.match(projection, /Array\.from\(props\.pendingPrompts\.keys\(\)\)\.filter\(\(messageId\) => visibleSet\.has\(messageId\)\)/)
  })

  it("uses a finite ceiling and leaves failed pages retryable", async () => {
    let attempts = 0
    const options = {
      hasAnchor: () => attempts === 2,
      hasMore: () => true,
      isCurrent: () => true,
      loadMore: async () => {
        attempts += 1
        if (attempts === 1) throw new Error("page failed")
      },
      maxPages: 1,
    }

    await assert.rejects(loadPagesUntilAnchor(options), /page failed/)
    assert.equal(attempts, 1)
    assert.equal(await loadPagesUntilAnchor(options), "found")

    attempts = 0
    await assert.rejects(loadPagesUntilAnchor({
      ...options,
      hasAnchor: () => false,
      loadMore: async () => { attempts += 1 },
    }), /page limit/)
    assert.equal(attempts, 1)
  })

  it("makes repeated anchor cursors retryable", async () => {
    let cursor = "same-page"
    await assert.rejects(loadPagesUntilAnchor({
      hasAnchor: () => false,
      hasMore: () => true,
      isCurrent: () => true,
      getCursor: () => cursor,
      loadMore: async () => { cursor = "same-page" },
    }), /cursor did not advance/)
  })

  it("loads native history pages before computing conversation search results", async () => {
    const pages = [["old page needle"], ["middle text"], ["recent needle"]]
    let page = 2
    let maxResident = 0
    const matches = await loadCompleteMessageHistory({
      getPageKey: () => String(page),
      loadOldest: async () => { page = 0 },
      loadNewer: async () => { page += 1 },
      isCurrent: () => true,
      isLatest: () => page === pages.length - 1,
      visit: () => {
        maxResident = Math.max(maxResident, pages[page].length)
        return pages[page].filter((message) => message.includes("needle"))
      },
    })
    assert.deepEqual(matches, ["old page needle", "recent needle"])
    assert.equal(maxResident, 1)
    assert.equal(page, 2)
  })

  it("does not move a stale search to the oldest page", async () => {
    let oldestLoads = 0
    assert.equal(await loadCompleteMessageHistory({
      getPageKey: () => "latest",
      loadOldest: async () => { oldestLoads += 1 },
      loadNewer: async () => {},
      isCurrent: () => false,
      isLatest: () => true,
      visit: () => ["stale"],
    }), null)
    assert.equal(oldestLoads, 0)
  })

  it("bounds exhaustive traversal without truncating realistic histories", async () => {
    let page = 2
    const options = {
      getPageKey: () => String(page),
      loadOldest: async () => { page = 0 },
      loadNewer: async () => { page += 1 },
      isCurrent: () => true,
      isLatest: () => false,
      visit: () => [page],
      maxPages: 3,
    }
    await assert.rejects(loadCompleteMessageHistory(options), /page limit/)
    assert.equal(page, 3)

    page = 2
    assert.deepEqual(await loadCompleteMessageHistory({
      ...options,
      isLatest: () => page === 2,
    }), [0, 1, 2])
  })

  for (const cancellation of ["query", "session"] as const) {
    it(`rejects conversation search results after ${cancellation} authority changes`, async () => {
      const sessionId = "session"
      let page = 1
      let currentQuery = "needle"
      let currentSession = sessionId
      const matches = await loadCompleteMessageHistory({
        getPageKey: () => String(page),
        loadOldest: async () => { page = 0 },
        loadNewer: async () => {
          page += 1
          if (cancellation === "query") currentQuery = "other"
          else currentSession = "other"
        },
        isCurrent: () => currentQuery === "needle" && currentSession === sessionId,
        isLatest: () => page === 1,
        visit: () => ["stale result"],
      })
      assert.equal(matches, null)
    })
  }

  it("retries a failed exhaustive search without changing its query", async () => {
    const query = "needle"
    let page = 1
    let attempts = 0
    const options = {
      getPageKey: () => String(page),
      loadOldest: async () => { page = 0 },
      loadNewer: async () => {
        attempts += 1
        if (attempts === 1) throw new Error("page failed")
        page = 1
      },
      isCurrent: () => true,
      isLatest: () => page === 1,
      visit: () => page === 1 ? [query] : [],
    }

    await assert.rejects(loadCompleteMessageHistory(options), /page failed/)
    assert.deepEqual(await loadCompleteMessageHistory(options), [query])
  })

  it("reports a repeated conversation-search cursor as a retryable failure", async () => {
    await assert.rejects(loadCompleteMessageHistory({
      getPageKey: () => "same-page",
      loadOldest: async () => {},
      loadNewer: async () => {},
      isCurrent: () => true,
      isLatest: () => false,
      visit: () => ["unreachable"],
    }), /cursor did not advance/)
  })

  it("stops ordinary pagination on a repeated cursor and accepts opaque cursor progress", async () => {
    let cursor: string | undefined = "older-page"
    const load = (nextCursor: string | undefined) => loadMessageHistoryPage({
      getCursor: () => cursor,
      loadMore: async () => {
        cursor = nextCursor
      },
    })

    assert.equal(await load("older-page"), false)
    assert.equal(await load("oldest-page"), true)
    assert.equal(await load(undefined), true)
  })

  it("only grants search-result authority to the searched query", () => {
    assert.equal(hasMessageSearchAuthority("current", "prior"), false)
    assert.equal(hasMessageSearchAuthority(" current ", "current"), true)
  })

  it("invalidates traversal authority synchronously on raw query input", () => {
    const source = fs.readFileSync(new URL("./message-section.tsx", import.meta.url), "utf8")
    const start = source.indexOf("function updateSearchQuery(query: string)")
    const updater = source.slice(start, source.indexOf("\n  }", start) + 4)
    assert.ok(start >= 0)
    assert.ok(updater.indexOf("invalidateMessageHistoryTraversal") < updater.indexOf("setSearchQuery(query)"))
    assert.match(source, /onInput=\{\(event\) => \{[\s\S]{0,200}updateSearchQuery\(event\.currentTarget\.value\)/)
    assert.match(source, /onCleanup\(\(\) => \{\s*searchLocatorAuthority\.reset\(\)\s*invalidateMessageHistoryTraversal/)
    assert.match(source, /isCurrent: \(\) => searchLocatorAuthority\.isCurrent\(locatorAuthority\)/)
  })

  it("reconciles resident additions and updates without treating eviction as deletion", () => {
    const previous = [
      { id: "historical", messageId: "old", text: "needle" },
      { id: "evicted", messageId: "evicted", text: "needle" },
      { id: "updated", messageId: "updated", text: "old needle" },
    ]
    assert.deepEqual(reconcileResidentSearchMatches({
      previous,
      currentResidentIds: ["updated", "added"],
      currentMatches: [
        { id: "updated-next", messageId: "updated", text: "new needle" },
        { id: "added", messageId: "added", text: "needle" },
      ],
    }), [previous[0], previous[1],
      { id: "updated-next", messageId: "updated", text: "new needle" },
      { id: "added", messageId: "added", text: "needle" },
    ])
  })

  it("reruns exhaustive search from native authority after destructive events", () => {
    const source = fs.readFileSync(new URL("./message-section.tsx", import.meta.url), "utf8")
    const traversal = source.slice(source.indexOf("const query = debouncedSearchQuery()"), source.indexOf("createEffect(() => {", source.indexOf("const query = debouncedSearchQuery()") + 1))
    assert.match(traversal, /const mutationRevision = getOpenCodeMutationRevision/)
    assert.match(traversal, /getOpenCodeMutationRevision\(instanceId, sessionId\) === mutationRevision/)
  })

  it("updates a resident middle match without moving its exhaustive position or identity", () => {
    const previous = [
      { id: "old:0", messageId: "old", preview: "old" },
      { id: "middle:0", messageId: "middle", preview: "before" },
      { id: "latest:0", messageId: "latest", preview: "latest" },
    ]
    const next = reconcileResidentSearchMatches({
      previous,
      currentResidentIds: ["middle"],
      currentMatches: [{ id: "middle:0", messageId: "middle", preview: "after" }],
    })

    assert.deepEqual(next.map((match) => match.messageId), ["old", "middle", "latest"])
    assert.equal(next[1].id, previous[1].id)
    assert.equal(next[1].preview, "after")
  })

  it("batches match and active-index replacement before locator effects run", () => {
    createRoot((dispose) => {
      const [matches, setMatches] = createSignal(["old", "middle", "latest"])
      const [activeIndex, setActiveIndex] = createSignal(1)
      const locatorCalls: string[] = []
      const locate = () => locatorCalls.push(matches()[activeIndex()])
      locate()

      batch(() => {
        setMatches(["middle", "latest"])
        setActiveIndex(0)
      })
      locate()

      assert.deepEqual(locatorCalls, ["middle", "middle"])
      const source = fs.readFileSync(new URL("./message-section.tsx", import.meta.url), "utf8")
      assert.match(source, /batch\(\(\) => \{\s*setSearchMatches\(next\)\s*setActiveSearchIndex\(nextActiveIndex\)/)
      dispose()
    })
  })

  it("locates the same off-page match again after query reset or traversal completion", () => {
    const authority = createSearchLocatorAuthority()
    const calls: string[] = []
    const locate = (id: string) => {
      const claim = authority.claim(id)
      if (claim) calls.push(id)
      return claim
    }

    const first = locate("same")
    assert.equal(authority.isCurrent(first!), true)
    locate("same")
    authority.reset(first!)
    assert.equal(authority.isCurrent(first!), false)
    const second = locate("same")
    authority.reset()
    locate("same")

    assert.deepEqual(calls, ["same", "same", "same"])
    authority.reset(second!)
  })
})
