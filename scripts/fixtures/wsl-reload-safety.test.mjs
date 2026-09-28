import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { prepareReloadSafety } from "./wsl-reload-safety.mjs"

test("event failure before observer return is awaited and releases the held provider", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-reload-consumer-"))
  let released = 0
  const client = {
    session: { create: async () => ({ id: "fixture" }), prompt: async () => {},
      form: { create: async () => ({ id: "form" }), list: async () => [{ id: "form" }] } },
    shell: { create: async () => ({ data: { id: "shell" } }), get: async () => ({ data: { status: "running" } }) },
    pty: { create: async () => ({ data: { id: "pty" } }), get: async () => ({ data: { status: "running" } }) },
    event: { subscribe: async function* () { throw new Error("event stream timeout") } },
    server: { info: async () => ({ pid: 123 }) },
  }
  try {
    await assert.rejects(prepareReloadSafety({ client, root, unc: value => value,
      provider: { waitForStream: async () => {}, release: async () => { released++ } },
    }), /event stream timeout/)
    assert.equal(released, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
