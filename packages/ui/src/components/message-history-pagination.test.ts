import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { hasMessageSearchAuthority, isMessageHistoryRestoreCurrent, loadCompleteMessageHistory, loadMessageHistoryPage, loadPagesUntilAnchor, MESSAGE_HISTORY_TOP_THRESHOLD_PX, shouldLoadOlderMessages } from "./message-history-pagination.ts"

describe("message history pagination", () => {
  const ready = {
    active: true,
    failed: false,
    hasMore: true,
    loading: false,
    messageCount: 2,
    scrollTop: MESSAGE_HISTORY_TOP_THRESHOLD_PX,
  }

  it("loads at the top threshold", () => {
    assert.equal(shouldLoadOlderMessages(ready), true)
    assert.equal(shouldLoadOlderMessages({ ...ready, scrollTop: MESSAGE_HISTORY_TOP_THRESHOLD_PX + 1 }), false)
  })

  it("guards inactive, exhausted, concurrent, failed, and empty loads", () => {
    assert.equal(shouldLoadOlderMessages({ ...ready, active: false }), false)
    assert.equal(shouldLoadOlderMessages({ ...ready, hasMore: false }), false)
    assert.equal(shouldLoadOlderMessages({ ...ready, loading: true }), false)
    assert.equal(shouldLoadOlderMessages({ ...ready, failed: true }), false)
    assert.equal(shouldLoadOlderMessages({ ...ready, messageCount: 0 }), false)
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

  it("invalidates anchor restore when the view deactivates or replaces its list", () => {
    const capturedList = {}
    assert.equal(isMessageHistoryRestoreCurrent(true, capturedList, capturedList, true), true)
    assert.equal(isMessageHistoryRestoreCurrent(false, capturedList, capturedList, true), false)
    assert.equal(isMessageHistoryRestoreCurrent(true, capturedList, {}, true), false)
    assert.equal(isMessageHistoryRestoreCurrent(true, capturedList, capturedList, false), false)
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
    const messages = ["recent text"]
    let cursor: string | undefined = "older-page"
    const matches = await loadCompleteMessageHistory({
      getCursor: () => cursor,
      loadMore: async () => {
        messages.unshift("old page needle")
        cursor = undefined
      },
      isCurrent: () => true,
      complete: () => messages.filter((message) => message.includes("needle")),
    })
    assert.deepEqual(matches, ["old page needle"])
  })

  for (const cancellation of ["query", "session"] as const) {
    it(`rejects conversation search results after ${cancellation} authority changes`, async () => {
      const sessionId = "session"
      let cursor: string | undefined = "older-page"
      let currentQuery = "needle"
      let currentSession = sessionId
      const matches = await loadCompleteMessageHistory({
        getCursor: () => cursor,
        loadMore: async () => {
          cursor = undefined
          if (cancellation === "query") currentQuery = "other"
          else currentSession = "other"
        },
        isCurrent: () => currentQuery === "needle" && currentSession === sessionId,
        complete: () => ["stale result"],
      })
      assert.equal(matches, null)
    })
  }

  it("retries a failed exhaustive search without changing its query", async () => {
    const query = "needle"
    let cursor: string | undefined = "older-page"
    let attempts = 0
    const options = {
      getCursor: () => cursor,
      loadMore: async () => {
        attempts += 1
        if (attempts === 1) throw new Error("page failed")
        cursor = undefined
      },
      isCurrent: () => true,
      complete: () => [query],
    }

    await assert.rejects(loadCompleteMessageHistory(options), /page failed/)
    assert.deepEqual(await loadCompleteMessageHistory(options), [query])
  })

  it("reports a repeated conversation-search cursor as a retryable failure", async () => {
    let cursor: string | undefined = "older-page"
    await assert.rejects(loadCompleteMessageHistory({
      getCursor: () => cursor,
      loadMore: async () => { cursor = "older-page" },
      isCurrent: () => true,
      complete: () => ["unreachable"],
    }), /cursor did not advance/)
  })

  it("stops ordinary pagination on a repeated cursor or no message progress", async () => {
    let cursor: string | undefined = "older-page"
    let messageCount = 2
    const load = (nextCursor: string | undefined, nextCount: number) => loadMessageHistoryPage({
      getCursor: () => cursor,
      getMessageCount: () => messageCount,
      loadMore: async () => {
        cursor = nextCursor
        messageCount = nextCount
      },
    })

    assert.equal(await load("older-page", 2), false)
    assert.equal(await load("older-page", 3), false)
    assert.equal(await load("oldest-page", 3), false)
    assert.equal(await load("final-page", 4), true)
  })

  it("only grants search-result authority to the searched query", () => {
    assert.equal(hasMessageSearchAuthority("current", "prior"), false)
    assert.equal(hasMessageSearchAuthority(" current ", "current"), true)
  })
})
