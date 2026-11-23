import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import Fastify from "fastify"
import { InstanceStore } from "./instance-store"
import { registerStorageRoutes } from "../server/routes/storage"

test("serialized prompt appends keep model selections and survive a fresh store", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codenomad-prompt-history-"))
  try {
    const store = new InstanceStore(dir)
    const project = "C:/fixture/été"
    const history = Array.from({ length: 100 }, (_, index) => `older-${index}`)
    const agentModelSelections = { build: { providerId: "fixture", modelId: "fixture" } }
    await store.write(project, { messageHistory: history, agentModelSelections })
    await Promise.all([store.appendHistory(project, "premier 🦀"), store.appendHistory(project, "second")])
    const reopened = new InstanceStore(dir)
    assert.deepEqual(await reopened.read(project), {
      messageHistory: ["second", "premier 🦀", ...history.slice(0, 98)],
      agentModelSelections,
    })
    assert.deepEqual((await reopened.read("C:/other")).messageHistory, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("the history route requires the live workspace and updates only its history", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codenomad-prompt-route-"))
  const app = Fastify()
  try {
    const store = new InstanceStore(dir)
    const project = "C:/fixture/project"
    const models = { build: { providerId: "p", modelId: "m" } }
    await store.write(project, { messageHistory: ["previous"], agentModelSelections: models })
    const deps = {
      instanceStore: store,
      eventBus: { publish() {} },
      workspaceManager: { get: (id: string) => id === "owned" ? { path: project } : undefined },
    } as Parameters<typeof registerStorageRoutes>[1]
    registerStorageRoutes(app, deps)
    const post = (id: string, text: unknown) => app.inject({ method: "POST", url: `/api/storage/instances/${id}`, payload: { text } })
    assert.equal((await post(encodeURIComponent(project), "wrong id")).statusCode, 404)
    assert.equal((await post("owned", 42)).statusCode, 400)
    assert.equal((await post("owned", "tentative 🦀")).statusCode, 204)
    const result = await app.inject({ method: "GET", url: "/api/storage/instances/owned" })
    assert.deepEqual(result.json(), { messageHistory: ["tentative 🦀", "previous"], agentModelSelections: models })
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})
