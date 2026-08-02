import assert from "node:assert/strict"
import test from "node:test"
import {
  buildSessionSearchMatches,
  createSessionSearchPager,
  findLastSessionSearchPage,
  retainSessionSearchPage,
} from "../../lib/session-search.ts"
import { getDefaultToolSearchText, getReadToolSearchText, getTaskToolSearchText } from "./search-text.ts"

function textRecord(id: string, text: string) {
  const partId = `${id}-part`
  return {
    id,
    sessionId: "session",
    role: "user",
    status: "complete",
    createdAt: 0,
    updatedAt: 0,
    revision: 1,
    partIds: [partId],
    parts: { [partId]: { id: partId, revision: 1, data: { id: partId, type: "text", text } } },
  }
}

function searchStore(messageIds: string[], records: Map<string, ReturnType<typeof textRecord>>) {
  return {
    getSessionMessageIds: () => messageIds,
    getMessage: (messageId: string) => records.get(messageId),
    getMessageInfo: () => undefined,
  } as any
}

async function collect(values: AsyncIterable<string>): Promise<string[]> {
  const result: string[] = []
  for await (const value of values) result.push(value)
  return result
}

test("task search keeps visible output ahead of an oversized prompt", async () => {
  const values = await collect(getTaskToolSearchText({
    toolCall: { type: "tool", id: "tool", tool: "task", state: {} } as any,
    toolName: "task",
    toolState: { status: "completed", input: { prompt: "x".repeat(20_000) }, output: "UNIQUE_RESULT" } as any,
  }))
  assert.equal(values.join("\n").includes("UNIQUE_RESULT"), true)
})

test("tool search retains output beyond the render preview limit", async () => {
  const values = await collect(getTaskToolSearchText({
    toolCall: { type: "tool", id: "tool", tool: "task", state: {} } as any,
    toolName: "task",
    toolState: { status: "completed", input: {}, output: `${"x".repeat(20_000)}TAIL_NEEDLE` } as any,
  }))
  assert.equal(values.join("\n").includes("TAIL_NEEDLE"), true)
})

test("task output tail matches remain exposed through a bounded visible preview", async () => {
  const record = textRecord("tool-tail", "")
  const partId = record.partIds[0]
  ;(record.parts as any)[partId] = {
    id: partId,
    revision: 1,
    data: { id: partId, type: "tool", tool: "task", state: { status: "completed", input: {}, output: `${"x".repeat(20_000)}TAIL_NEEDLE` } },
  } as any
  const result = await buildSessionSearchMatches({
    store: searchStore([record.id], new Map([[record.id, record]])),
    sessionId: "session",
    query: "TAIL_NEEDLE",
    includeThinking: false,
    resolveToolSearchText: getTaskToolSearchText,
  })

  assert.equal(result.matches[0]?.preview.includes("TAIL_NEEDLE"), true)
  assert.ok((result.matches[0]?.preview.length ?? 0) <= 120)
})

test("case-fold expansion preserves original string offsets", async () => {
  const record = textRecord("unicode", "İİxy")
  const result = await buildSessionSearchMatches({
    store: searchStore([record.id], new Map([[record.id, record]])),
    sessionId: "session",
    query: "xy",
    includeThinking: false,
  })

  assert.deepEqual(result.matches.map(({ start, end }) => ({ start, end })), [{ start: 2, end: 4 }])
})

test("small structured output remains searchable as rendered JSON", async () => {
  const values = await collect(getTaskToolSearchText({
    toolCall: { type: "tool", id: "tool", tool: "task", state: {} } as any,
    toolName: "task",
    toolState: { status: "completed", input: {}, output: { status: "failed", detail: null } } as any,
  }))
  assert.equal(values.some((value) => value.includes('"status": "failed"')), true)
  assert.equal(values.some((value) => value.includes('"detail": null')), true)
})

test("complete-session search includes messages older than the former corpus window", async () => {
  const messageIds = ["old", ...Array.from({ length: 10_000 }, (_, index) => `new-${index}`)]
  const { matches } = await buildSessionSearchMatches({
    store: searchStore(messageIds, new Map([["old", textRecord("old", "distant needle")]])),
    sessionId: "session",
    query: "needle",
    includeThinking: false,
  })
  assert.equal(matches[0]?.messageId, "old")
})

test("complete-session search includes every part", async () => {
  const record = textRecord("message", "")
  record.partIds = Array.from({ length: 20_001 }, (_, index) => `part-${index}`)
  record.parts = Object.fromEntries(record.partIds.map((id, index) => [
    id,
    { id, revision: 1, data: { id, type: "text", text: index === 20_000 ? "final needle" : "" } },
  ]))
  const { matches } = await buildSessionSearchMatches({
    store: searchStore([record.id], new Map([[record.id, record]])),
    sessionId: "session",
    query: "needle",
    includeThinking: false,
  })
  assert.equal(matches[0]?.partId, "part-20000")
})

test("complete-session search includes characters beyond former per-part and total limits", async () => {
  const record = textRecord("large", `${"x".repeat(5_000_001)}needle`)
  const { matches } = await buildSessionSearchMatches({
    store: searchStore([record.id], new Map([[record.id, record]])),
    sessionId: "session",
    query: "needle",
    includeThinking: false,
  })
  assert.equal(matches[0]?.start, 5_000_001)
})

test("chunked search finds a match spanning a chunk boundary", async () => {
  const record = textRecord("boundary", `${"x".repeat(65_534)}needle`)
  const { matches, totalMatches } = await buildSessionSearchMatches({
    store: searchStore([record.id], new Map([[record.id, record]])),
    sessionId: "session",
    query: "needle",
    includeThinking: false,
  })
  assert.equal(totalMatches, 1)
  assert.equal(matches[0]?.start, 65_534)
})

test("chunked search carries non-overlap offsets across chunk boundaries", async () => {
  const record = textRecord("non-overlap-boundary", "a".repeat(65_550))
  const { matches } = await buildSessionSearchMatches({
    store: searchStore([record.id], new Map([[record.id, record]])),
    sessionId: "session",
    query: "aaa",
    includeThinking: false,
    limit: 30_000,
  })
  const starts = matches.map((match) => match.start)
  const boundaryIndex = starts.indexOf(65_535)

  assert.deepEqual(starts.slice(boundaryIndex, boundaryIndex + 3), [65_535, 65_538, 65_541])
  assert.equal(starts.every((start, index) => start === index * 3), true)
})

test("complete-session search does not shorten the query", async () => {
  const query = "q".repeat(1_001)
  const record = textRecord("query", query)
  const { matches } = await buildSessionSearchMatches({
    store: searchStore([record.id], new Map([[record.id, record]])),
    sessionId: "session",
    query,
    includeThinking: false,
  })
  assert.equal(matches[0]?.end, query.length)
})

test("oversized literal matches preserve offsets and retain only a bounded preview", async () => {
  const query = "Ab".repeat(50_000)
  const record = textRecord("oversized-preview", `İİ${query.toLowerCase()}:suffix`)
  const { matches } = await buildSessionSearchMatches({
    store: searchStore([record.id], new Map([[record.id, record]])),
    sessionId: "session",
    query,
    includeThinking: false,
  })

  assert.deepEqual(matches.map(({ start, end }) => ({ start, end })), [{ start: 2, end: 2 + query.length }])
  assert.ok((matches[0]?.preview.length ?? 0) < 300)
})

test("oversized literal misses stay responsive and cancel at the scanner checkpoint", async () => {
  const record = textRecord("oversized-miss", "a".repeat(200_000))
  const controller = new AbortController()
  const startedAt = Date.now()
  let yields = 0

  await assert.rejects(
    buildSessionSearchMatches({
      store: searchStore([record.id], new Map([[record.id, record]])),
      sessionId: "session",
      query: `${"a".repeat(100_000)}b`,
      includeThinking: false,
      signal: controller.signal,
      yieldControl: async () => {
        yields += 1
        controller.abort()
      },
    }),
    (error: any) => error?.name === "AbortError",
  )

  assert.ok(yields > 0)
  assert.ok(Date.now() - startedAt < 2_000)
})

test("paged search keeps matches after the first thousand reachable", async () => {
  const record = textRecord("many", `${"needle ".repeat(1_001)}tail needle`)
  const store = searchStore([record.id], new Map([[record.id, record]]))
  const pager = createSessionSearchPager({
    store,
    sessionId: "session",
    query: "needle",
    includeThinking: false,
    limit: 250,
  })
  const first = await pager.nextPage()
  let later = first
  while (later.hasMore) later = await pager.nextPage()

  assert.equal(first.totalMatches, null)
  assert.equal(first.matches.length, 250)
  assert.equal(later.totalMatches, 1_002)
  assert.equal(later.offset, 1_000)
  assert.equal(later.matches.at(-1)?.occurrence, 1_001)
})

test("session search yields and honors stale-generation cancellation", async () => {
  const records = new Map<string, ReturnType<typeof textRecord>>()
  const messageIds = Array.from({ length: 200 }, (_, index) => {
    const id = `message-${index}`
    records.set(id, textRecord(id, "searchable text"))
    return id
  })
  const controller = new AbortController()
  let yields = 0

  await assert.rejects(
    buildSessionSearchMatches({
      store: searchStore(messageIds, records),
      sessionId: "session",
      query: "absent",
      includeThinking: false,
      signal: controller.signal,
      yieldControl: async () => {
        yields += 1
        controller.abort()
      },
    }),
    (error: any) => error?.name === "AbortError",
  )
  assert.ok(yields > 0)
})

test("tool search handles deeply nested and cyclic structured output", async () => {
  let output: any = "DEEPEST_NEEDLE"
  for (let depth = 0; depth < 20_000; depth += 1) output = [output]
  const cycle: any = { output }
  cycle.self = cycle

  const values = await collect(getTaskToolSearchText({
    toolCall: { type: "tool", id: "tool", tool: "task", state: {} } as any,
    toolName: "task",
    toolState: { status: "completed", input: {}, output: cycle } as any,
  }))
  assert.equal(values.includes("DEEPEST_NEEDLE"), true)
})

test("tool search includes text rendered in specialized titles", async () => {
  const base = { toolCall: { type: "tool", id: "tool", tool: "grep", state: {} } as any }
  const searchValues = await collect(getDefaultToolSearchText({
    ...base,
    toolName: "grep",
    toolState: { status: "completed", input: { pattern: "release-[0-9]+" }, output: "" } as any,
  }))
  const taskValues = await collect(getTaskToolSearchText({
    ...base,
    toolName: "task",
    toolState: { status: "completed", input: { description: "audit reconnect" }, output: "" } as any,
  }))
  const readValues = await collect(getReadToolSearchText({
    ...base,
    toolName: "read",
    toolState: { status: "completed", input: { path: "file.ts", offset: 40, limit: 20 } } as any,
  }))

  assert.ok(searchValues.includes("release-[0-9]+"))
  assert.ok(taskValues.includes("audit reconnect"))
  assert.ok(readValues.some((value) => value.includes("40")))
  assert.ok(readValues.some((value) => value.includes("20")))
})

test("running default tools search the same fallback content they render", async () => {
  for (const fallback of [
    { diff: "DIFF_NEEDLE" },
    { preview: "PREVIEW_NEEDLE" },
  ]) {
    const values = await collect(getDefaultToolSearchText({
      toolCall: { type: "tool", id: "tool", tool: "grep", state: {} } as any,
      toolName: "grep",
      toolState: { status: "running", input: { content: "INPUT_NEEDLE" }, metadata: fallback } as any,
    }))
    assert.equal(values.includes(Object.values(fallback)[0]!), true)
  }

  const values = await collect(getDefaultToolSearchText({
    toolCall: { type: "tool", id: "tool", tool: "invalid", state: {} } as any,
    toolName: "invalid",
    toolState: { status: "error", input: { content: "INPUT_NEEDLE" }, metadata: { output: "" } } as any,
  }))
  assert.equal(values.includes("INPUT_NEEDLE"), true)
})

test("pager resumes extraction without revisiting earlier transcript content", async () => {
  const records = new Map([["message", textRecord("message", "needle ".repeat(600))]])
  let recordReads = 0
  const store = searchStore(["message"], records)
  const originalGetMessage = store.getMessage
  store.getMessage = (messageId: string) => {
    recordReads += 1
    return originalGetMessage(messageId)
  }
  const pager = createSessionSearchPager({ store, sessionId: "session", query: "needle", includeThinking: false })

  await pager.nextPage()
  await pager.nextPage()

  assert.equal(recordReads, 1)
})

test("retained search pages stay bounded and last-page discovery reaches the final match", async () => {
  const records = new Map([["message", textRecord("message", "needle ".repeat(9))]])
  const pager = createSessionSearchPager({
    store: searchStore(["message"], records),
    sessionId: "session",
    query: "needle",
    includeThinking: false,
    limit: 2,
  })
  const retained = new Map<number, Awaited<ReturnType<typeof pager.nextPage>>>()
  let nextPageIndex = 0
  const last = await findLastSessionSearchPage(async (pageIndex) => {
    assert.equal(pageIndex, nextPageIndex)
    const page = await pager.nextPage()
    retainSessionSearchPage(retained, pageIndex, page, 3)
    nextPageIndex += 1
    return page
  })

  assert.equal(last.pageIndex, 4)
  assert.equal(last.result.matches.at(-1)?.occurrence, 8)
  assert.deepEqual([...retained.keys()], [2, 3, 4])
})

test("a refreshed pager clamps a shrunken result set to its first valid page", async () => {
  const records = new Map([["message", textRecord("message", "needle ".repeat(300))]])
  const store = searchStore(["message"], records)
  const first = await createSessionSearchPager({ store, sessionId: "session", query: "needle", includeThinking: false }).nextPage()
  assert.equal(first.hasMore, true)

  records.set("message", textRecord("message", "needle ".repeat(100)))
  const refreshed = await createSessionSearchPager({ store, sessionId: "session", query: "needle", includeThinking: false }).nextPage()
  assert.equal(refreshed.offset, 0)
  assert.equal(refreshed.matches.length, 100)
  assert.equal(refreshed.totalMatches, 100)
})

test("tool extraction yields and can be cancelled inside a large payload", async () => {
  const record = textRecord("tool-message", "")
  const partId = "tool-part"
  record.partIds = [partId]
  record.parts = {
    [partId]: {
      id: partId,
      revision: 1,
      data: {
        id: partId,
        type: "tool",
        tool: "task",
        state: { status: "completed", input: {}, output: Array.from({ length: 20_000 }, (_, index) => `value-${index}`) },
      },
    },
  } as any
  const controller = new AbortController()
  let yields = 0

  await assert.rejects(
    buildSessionSearchMatches({
      store: searchStore([record.id], new Map([[record.id, record]])),
      sessionId: "session",
      query: "absent",
      includeThinking: false,
      signal: controller.signal,
      yieldControl: async () => {
        yields += 1
        controller.abort()
      },
    }),
    (error: any) => error?.name === "AbortError",
  )
  assert.ok(yields > 0)
})
