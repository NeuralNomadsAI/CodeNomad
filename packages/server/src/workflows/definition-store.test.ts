import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import {
  WORKFLOW_DEFINITION_HISTORY_BYTES_LIMIT,
  WORKFLOW_DEFINITION_RECORD_LIMIT,
  WORKFLOW_DEFINITION_REVISION_LIMIT,
  WorkflowDefinitionStore,
} from "./definition-store"

const definition = (name: string) => ({
  version: 1 as const,
  id: "stored",
  name,
  root: { type: "agent" as const, id: "work", instructions: "Work" },
})

describe("WorkflowDefinitionStore", () => {
  it("rejects definition IDs that can collide by case", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-definition-store-case-"))
    try {
      const store = new WorkflowDefinitionStore(directory)
      await assert.rejects(store.create({ ...definition("Uppercase"), id: "Stored" }), /lowercase/)
      assert.equal((await store.create(definition("Lowercase"))).id, "stored")
      await assert.rejects(store.get("Stored"), /Invalid workflow definition ID/)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("keeps immutable revisions and atomically persists a tombstone", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-definition-store-"))
    try {
      const store = new WorkflowDefinitionStore(directory)
      const first = await store.create(definition("First"))
      const second = await store.update("stored", 1, definition("Second"))
      assert.equal(first.revision, 1)
      assert.equal(second.revision, 2)
      assert.equal((await store.get("stored", 1))?.definition.name, "First")
      assert.equal((await store.get("stored"))?.definition.name, "Second")
      await assert.rejects(store.update("stored", 1, definition("Stale")), /revision is 2/)
      assert.equal(await store.delete("stored", 2), true)
      assert.equal(await store.get("stored"), undefined)
      assert.equal(await store.get("stored", 1), undefined)
      assert.equal((await store.inspectRevision("stored", 1))?.definition.name, "First")
      assert.equal((await store.inspectRevision("stored", 2))?.definition.name, "Second")
      assert.deepEqual((await fs.readdir(directory)).filter((entry) => entry.endsWith(".tmp")), [])
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("bounds revision count without pruning immutable or tombstoned history", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-definition-store-count-"))
    try {
      const store = new WorkflowDefinitionStore(directory)
      await store.create(definition("Revision 1"))
      for (let revision = 2; revision <= WORKFLOW_DEFINITION_REVISION_LIMIT; revision++) {
        await store.update("stored", revision - 1, definition(`Revision ${revision}`))
      }
      await assert.rejects(
        store.update("stored", WORKFLOW_DEFINITION_REVISION_LIMIT, definition("Over limit")),
        /revision limit reached/,
      )
      assert.equal((await store.get("stored"))?.revision, WORKFLOW_DEFINITION_REVISION_LIMIT)
      assert.equal((await store.inspectRevision("stored", 1))?.definition.name, "Revision 1")
      assert.equal(await store.delete("stored", WORKFLOW_DEFINITION_REVISION_LIMIT), true)
      assert.equal(await store.get("stored"), undefined)
      assert.equal((await store.inspectRevision("stored", WORKFLOW_DEFINITION_REVISION_LIMIT))?.definition.name, `Revision ${WORKFLOW_DEFINITION_REVISION_LIMIT}`)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("bounds aggregate revision bytes without blocking tombstones", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-definition-store-bytes-"))
    try {
      const store = new WorkflowDefinitionStore(directory)
      const largeDefinition = (name: string) => ({
        version: 1 as const,
        id: "stored",
        name,
        root: {
          type: "sequence" as const,
          id: "root",
          steps: Array.from({ length: 5 }, (_, index) => ({
            type: "agent" as const,
            id: `work-${index}`,
            instructions: `${index}${"x".repeat(49_000)}`,
          })),
        },
      })
      let revision = (await store.create(largeDefinition("Large 1"))).revision
      await assert.rejects(async () => {
        while (revision < WORKFLOW_DEFINITION_REVISION_LIMIT) {
          revision = (await store.update("stored", revision, largeDefinition(`Large ${revision + 1}`))).revision
        }
      }, /history size limit reached/)
      assert.ok(revision < WORKFLOW_DEFINITION_REVISION_LIMIT)
      const storedPath = path.join(directory, "stored.json")
      const persisted = JSON.parse(await fs.readFile(storedPath, "utf8")) as { revisions: unknown[] }
      assert.ok(persisted.revisions.reduce<number>((total, record) => total + Buffer.byteLength(JSON.stringify(record), "utf8"), 0) <= WORKFLOW_DEFINITION_HISTORY_BYTES_LIMIT)
      assert.equal((await store.get("stored"))?.revision, revision)
      assert.equal((await store.inspectRevision("stored", 1))?.definition.name, "Large 1")
      assert.equal(await store.delete("stored", revision), true)
      assert.equal((await store.inspectRevision("stored", revision))?.revision, revision)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("bounds active and tombstoned definition records", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-definition-store-records-"))
    try {
      await Promise.all(Array.from({ length: WORKFLOW_DEFINITION_RECORD_LIMIT }, (_, index) =>
        fs.writeFile(path.join(directory, `old-${index}.json`), "{}")))
      const store = new WorkflowDefinitionStore(directory)
      await assert.rejects(store.create(definition("Over limit")), /record limit reached/)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})
