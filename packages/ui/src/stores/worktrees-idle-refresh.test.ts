import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"

import { serverApi } from "../lib/api-client"
import { sdkManager } from "../lib/sdk-manager"
import {
  refreshWorktreesOnIdle,
  reloadWorktrees,
  worktreesByInstance,
  getWorktreeSlugForParentSession,
} from "./worktrees"
import { setActiveSessionId, setSessions } from "./session-state"

// ---------------------------------------------------------------------------
// These tests patch the MUTABLE exported `serverApi` object methods and the
// `sdkManager.createClient` instance method (matching the repo convention of
// not using ESM module mocking). The worktree-scoped client is replaced with a
// fake whose `session.get`/`session.update` resolve, so the auto-switch flows
// through the REAL metadata write path and the resulting slug is observable via
// `getWorktreeSlugForParentSession`.
// ---------------------------------------------------------------------------

type WorktreeDescriptor = { slug: string; directory: string; branch?: string }

const INSTANCE = "inst-1"
const PARENT = "parent-session-1"

const DEBOUNCE_WAIT_MS = 750

// Captured originals for restoration.
const originalFetchWorktrees = serverApi.fetchWorktrees
const originalReadWorktreeMap = serverApi.readWorktreeMap
const originalWriteWorktreeMap = serverApi.writeWorktreeMap
const originalCreateClient = sdkManager.createClient

let fetchCalls = 0
let currentWorktrees: WorktreeDescriptor[] = []

// In-memory session metadata store backing the fake opencode client, so the
// real `setSessionWorktreeSlugWithClient` path persists + reads back correctly.
const sessionMetadataStore = new Map<string, Record<string, unknown>>()

function installStubs(): void {
  fetchCalls = 0

  serverApi.fetchWorktrees = (async (_id: string) => {
    fetchCalls += 1
    return { worktrees: currentWorktrees.slice(), isGitRepo: true }
  }) as typeof serverApi.fetchWorktrees

  serverApi.readWorktreeMap = (async (_id: string) => ({
    version: 1 as const,
    defaultWorktreeSlug: "root",
    parentSessionWorktreeSlug: {},
  })) as typeof serverApi.readWorktreeMap

  serverApi.writeWorktreeMap = (async (_id: string, _map: unknown) => undefined) as typeof serverApi.writeWorktreeMap

  // Fake opencode client: session.get/update read+write the in-memory store.
  sdkManager.createClient = ((_instanceId: string, _proxyPath: string, _slug?: string) => ({
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({
        data: { id: sessionID, metadata: sessionMetadataStore.get(sessionID) ?? {} },
      }),
      update: async ({ sessionID, metadata }: { sessionID: string; metadata: Record<string, unknown> }) => {
        sessionMetadataStore.set(sessionID, metadata)
        return { data: { id: sessionID, metadata } }
      },
    },
  })) as unknown as typeof sdkManager.createClient
}

function restoreStubs(): void {
  serverApi.fetchWorktrees = originalFetchWorktrees
  serverApi.readWorktreeMap = originalReadWorktreeMap
  serverApi.writeWorktreeMap = originalWriteWorktreeMap
  sdkManager.createClient = originalCreateClient
}

function seedSession(opts: { id: string; parentId?: string | null }): void {
  setSessions((prev) => {
    const next = new Map(prev)
    const instanceSessions = next.get(INSTANCE) ?? new Map()
    instanceSessions.set(opts.id, {
      id: opts.id,
      parentId: opts.parentId ?? null,
      instanceId: INSTANCE,
      metadata: sessionMetadataStore.get(opts.id) ?? {},
    } as any)
    next.set(INSTANCE, instanceSessions)
    return next
  })
}

function setActive(sessionId: string): void {
  setActiveSessionId((prev) => {
    const next = new Map(prev)
    next.set(INSTANCE, sessionId)
    return next
  })
}

function wt(slug: string): WorktreeDescriptor {
  return { slug, directory: `/repo/${slug}` }
}

function setWorktrees(list: WorktreeDescriptor[]): void {
  currentWorktrees = list
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

beforeEach(() => {
  sessionMetadataStore.clear()
  installStubs()
  setSessions(() => new Map())
  setActiveSessionId(() => new Map())
})

afterEach(() => {
  restoreStubs()
})

describe("refreshWorktreesOnIdle", () => {
  it("(1) reloads the worktree list on idle", async () => {
    seedSession({ id: PARENT })
    setActive(PARENT)
    setWorktrees([wt("root"), wt("agent-tree")])

    refreshWorktreesOnIdle(INSTANCE, PARENT)
    await wait(DEBOUNCE_WAIT_MS)

    assert.equal(fetchCalls, 1)
    const slugs = (worktreesByInstance().get(INSTANCE) ?? []).map((w) => w.slug)
    assert.deepEqual(slugs, ["root", "agent-tree"])
  })

  it("(2) coalesces N rapid idles into a single fetch (debounce)", async () => {
    seedSession({ id: PARENT })
    setActive(PARENT)
    setWorktrees([wt("root")])

    for (let i = 0; i < 5; i++) {
      refreshWorktreesOnIdle(INSTANCE, PARENT)
    }
    await wait(DEBOUNCE_WAIT_MS)

    assert.equal(fetchCalls, 1)
  })

  it("(3) in-flight guard prevents overlapping reloads", async () => {
    let releaseFetch: (() => void) | undefined
    serverApi.fetchWorktrees = (async (_id: string) => {
      fetchCalls += 1
      await new Promise<void>((resolve) => {
        releaseFetch = resolve
      })
      return { worktrees: [wt("root")], isGitRepo: true }
    }) as typeof serverApi.fetchWorktrees

    const a = reloadWorktrees(INSTANCE)
    const b = reloadWorktrees(INSTANCE)
    assert.equal(fetchCalls, 1)

    releaseFetch?.()
    await Promise.all([a, b])
    assert.equal(fetchCalls, 1)
  })

  it("(4) single new worktree -> auto-switch updates parent session slug", async () => {
    seedSession({ id: PARENT })
    setActive(PARENT)
    setWorktrees([wt("root")])
    await reloadWorktrees(INSTANCE)
    assert.equal(getWorktreeSlugForParentSession(INSTANCE, PARENT), "root")

    // Agent added exactly one worktree during the turn.
    setWorktrees([wt("root"), wt("agent-tree")])
    refreshWorktreesOnIdle(INSTANCE, PARENT)
    await wait(DEBOUNCE_WAIT_MS)

    assert.equal(getWorktreeSlugForParentSession(INSTANCE, PARENT), "agent-tree")
  })

  it("(5a) zero new worktrees -> mapping untouched", async () => {
    seedSession({ id: PARENT })
    setActive(PARENT)
    setWorktrees([wt("root")])
    await reloadWorktrees(INSTANCE)

    setWorktrees([wt("root")])
    refreshWorktreesOnIdle(INSTANCE, PARENT)
    await wait(DEBOUNCE_WAIT_MS)

    assert.equal(getWorktreeSlugForParentSession(INSTANCE, PARENT), "root")
  })

  it("(5b) multiple new worktrees -> ambiguous, mapping untouched", async () => {
    seedSession({ id: PARENT })
    setActive(PARENT)
    setWorktrees([wt("root")])
    await reloadWorktrees(INSTANCE)

    setWorktrees([wt("root"), wt("tree-a"), wt("tree-b")])
    refreshWorktreesOnIdle(INSTANCE, PARENT)
    await wait(DEBOUNCE_WAIT_MS)

    assert.equal(getWorktreeSlugForParentSession(INSTANCE, PARENT), "root")
  })

  it("(6) guard: viewing a different active session -> no auto-switch", async () => {
    seedSession({ id: PARENT })
    seedSession({ id: "other-session" })
    // User is actively viewing a DIFFERENT session than the one going idle.
    setActive("other-session")
    setWorktrees([wt("root")])
    await reloadWorktrees(INSTANCE)

    setWorktrees([wt("root"), wt("agent-tree")])
    refreshWorktreesOnIdle(INSTANCE, PARENT)
    await wait(DEBOUNCE_WAIT_MS)

    // List still refreshed...
    const slugs = (worktreesByInstance().get(INSTANCE) ?? []).map((w) => w.slug)
    assert.deepEqual(slugs, ["root", "agent-tree"])
    // ...but no switch performed for the idle (non-active) session.
    assert.equal(getWorktreeSlugForParentSession(INSTANCE, PARENT), "root")
  })
})
