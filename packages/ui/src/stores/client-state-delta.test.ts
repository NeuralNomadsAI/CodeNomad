import assert from "node:assert/strict"
import { test } from "node:test"
import type { ClientSnapshotV2, RestorableWorkspaceTabState } from "./client-state"
import { captureSessionCatalog } from "./session-catalog-persistence"
import type { Session } from "../types/session"

test("saving one changed outline in a large restored workspace", async (t) => {
  const baseline = process.env.CODENOMAD_CLIENT_STATE_BENCH_BASELINE === "1"
  const storage = { length: 0, getItem: () => null, setItem() {} }
  let bytes = 0, sent = 0, encodedAt = 0
  const storedKeys = new Set<string>()
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    __CODENOMAD_RUNTIME_HOST__: "electron", __CODENOMAD_WINDOW_CONTEXT__: "local", localStorage: storage,
    electronAPI: {
      claimClientStateAccess: async () => true,
      loadClientState: async () => ({ isPrimary: true, restoreEnabled: true, snapshot: null, partitionProtocolVersion: 1 }),
      loadClientStatePartition: async () => null,
      commitClientStatePartitions: async (_token: string, payload: { snapshot: ClientSnapshotV2; partitions: Record<string, string> }) => {
        encodedAt = performance.now()
        sent = Object.keys(payload.partitions).length
        bytes = Buffer.byteLength(JSON.stringify(payload))
        Object.keys(payload.partitions).forEach(key => storedKeys.add(key))
        const current = new Set(payload.snapshot.partitionKeys)
        for (const key of storedKeys) if (!current.has(key)) storedKeys.delete(key)
        assert.deepEqual([...storedKeys].sort(), payload.snapshot.partitionKeys)
        return true
      },
    },
  } })
  t.after(() => Reflect.deleteProperty(globalThis, "window"))
  const state = await import("./client-state")
  await state.initializeClientState()
  const directory = "/fixture", projectID = "project"
  const owner = {}
  const draft = "x".repeat(256)
  const rows = Array.from({ length: 500 }, (_, i) => ({
    id: `session-${i}`, title: `Session ${i} ${"description ".repeat(690)}`, parentId: i ? "session-0" : null,
    projectID, location: { directory }, time: { created: 1, updated: 1 },
    agent: "build", model: { providerId: "p", modelId: "m" }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })) as Session[]
  const marks = Object.fromEntries(rows.slice(0, 300).map(({ id }, i) => [id, i + 1]))
  const outline = Array.from({ length: 1024 }, (_, seq) => ({
    id: `msg-${seq}-${"a".repeat(100)}`, seq, type: "assistant" as const, tools: 0, reasoning: 0,
  }))
  const hashes = t.mock.method(crypto.subtle, "digest")
  const measures: Array<{ bytes: number; sha256: number; ms: number }> = []
  for (let step = 0; step < 14; step++) {
    hashes.mock.resetCalls()
    const started = performance.now()
    const tab: RestorableWorkspaceTabState = {
      kind: "workspace", folder: directory, activeSessionId: "session-0",
      drafts: { "session-0": draft }, attachments: {}, scrollSnapshots: {},
      unseenIdleSince: Object.fromEntries(Object.entries(marks).slice(0, 150)),
      seenInterruptions: Object.fromEntries(Object.entries(marks).slice(150)),
      generationRecovery: {},
      sessionCatalog: captureSessionCatalog(rows, owner),
      outlineIndexes: { "session-0": {
        format: 1, directory, projectID,
        entries: [...outline.slice(0, -1), { ...outline.at(-1)!, reasoning: step }],
        checkpoints: [{ after: -1, through: 1023, digest: "b".repeat(64) }],
      } },
    }
    state.updateRestorableSession({ tabs: [tab], activeTabIndex: 0 })
    await state.flushClientState()
    if (step === 0) {
      assert.ok(sent >= 306)
      assert.ok(bytes > 4_000_000)
    } else if (!baseline) {
      assert.equal(sent, 4, "outline, session document, workspace and session manifest")
      assert.ok(bytes < 200_000)
      assert.equal(hashes.mock.callCount(), 4)
    }
    if (step >= 4) measures.push({ bytes, sha256: hashes.mock.callCount(), ms: encodedAt - started })
  }
  const median = measures.map(m => m.ms).sort((a, b) => a - b)
  t.diagnostic(`${baseline ? "baseline" : "delta"}: ${bytes} IPC bytes, ${measures[0]!.sha256} SHA-256 calls, ${((median[4]! + median[5]!) / 2).toFixed(2)} ms median capture+encode (10 saves)`)
})
