import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import Fastify from "fastify"
import { OPENCODE_LOG_BYTES, readOpenCodeLogs } from "./logs"
import { registerOpenCodeLogsRoutes } from "../server/routes/opencode-logs"

test("reads the real fixed log file, bounds its tail and preserves UTF-8", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-log-test-"))
  try {
    const file = path.join(directory, "opencode.log")
    const read = () => readOpenCodeLogs("opencode", async () => directory)
    await writeFile(file, "role=server Unicode: été שלום\n")
    assert.deepEqual(await read(), { path: file, text: "role=server Unicode: été שלום\n", truncated: false })
    await writeFile(file, "discard\n" + "role=server été\n".repeat(OPENCODE_LOG_BYTES / 8))
    const large = await read()
    assert.equal(large.truncated, true)
    assert.ok(Buffer.byteLength(large.text) <= OPENCODE_LOG_BYTES)
    assert.ok(large.text.startsWith("role=server été\n"))
    assert.ok(!large.text.includes("�"))
    await writeFile(file, "new run\n")
    assert.equal((await read()).text, "new run\n", "an explicit re-read follows file replacement/truncation")
    await assert.rejects(readOpenCodeLogs("opencode", async () => "relative"))
    await assert.rejects(readOpenCodeLogs("opencode", async () => directory + "\nother"))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("log route accepts no path selectors, fences binary changes and returns fixed errors", async () => {
  const app = Fastify()
  let binary = "opencode", reads = 0
  let fail = false, change = false
  registerOpenCodeLogsRoutes(app, { resolveBinary: () => binary, read: async selected => {
    reads++
    assert.equal(selected, binary)
    if (fail) throw Object.assign(new Error("private file detail"), { code: "ENOENT" })
    if (change) binary = "other"
    return { path: "/logs/opencode.log", text: "role=server real output", truncated: false }
  } })
  try {
    assert.equal((await app.inject("/api/opencode/logs?path=/secrets")).statusCode, 400)
    assert.equal(reads, 0)
    const result = await app.inject("/api/opencode/logs")
    assert.equal(result.statusCode, 200)
    assert.equal(result.headers["cache-control"], "no-store")
    assert.equal(result.json().text, "role=server real output")
    change = true
    assert.equal((await app.inject("/api/opencode/logs")).statusCode, 409)
    fail = true
    const missing = await app.inject("/api/opencode/logs")
    assert.equal(missing.statusCode, 404)
    assert.deepEqual(missing.json(), { error: "opencode_logs_missing" })
  } finally { await app.close() }
})
