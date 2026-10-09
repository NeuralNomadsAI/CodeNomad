import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { OpenCode, type CredentialEntry } from "@opencode/client"
import type { ServiceConnection } from "../workspaces/opencode-service"
import { projectCredentials, readUsageCredentials } from "./native-credentials"

const entries: CredentialEntry[] = [
  { id: "a", integrationID: "deepinfra", label: "Key", active: true, value: { type: "key", key: "secret-key", metadata: { note: "x" } } },
  { id: "b", integrationID: "anthropic", label: "Old", active: false, value: { type: "key", key: "inactive" } },
  { id: "c", integrationID: "anthropic", label: "Pro", active: true,
    value: { type: "oauth", methodID: "claude", access: "secret-access", refresh: "secret-refresh", expires: 42, metadata: { accountID: "acct", email: "a@b.c" } } },
]

test("projects only each integration's active native credential, without unrelated metadata", () => {
  assert.deepEqual(projectCredentials(entries), {
    deepinfra: { type: "api", key: "secret-key" },
    anthropic: { type: "oauth", access: "secret-access", refresh: "secret-refresh", expires: 42, accountId: "acct" },
  })
})

async function daemon(status: number) {
  const server = createServer((_req, res) => {
    res.statusCode = status
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify(status === 200 ? { data: entries } : {}))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` })
  const close = () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
  return { connection: { client, assertCurrent: () => {} } as ServiceConnection, close }
}

test("reads native credentials and falls back to auth.json only when the API is missing", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-native-credentials-"))
  const previous = process.env.OPENCODE_AUTH_FILE
  process.env.OPENCODE_AUTH_FILE = path.join(directory, "auth.json")
  fs.writeFileSync(process.env.OPENCODE_AUTH_FILE, JSON.stringify({ deepinfra: { type: "api", key: "legacy" } }))
  const current = await daemon(200)
  const missing = await daemon(404)
  const failing = await daemon(500)
  try {
    const key = (auth: Record<string, unknown>) => (auth.deepinfra as { key?: string } | undefined)?.key
    assert.equal(key(await readUsageCredentials(current.connection, AbortSignal.timeout(2000))), "secret-key")
    assert.equal(key(await readUsageCredentials(missing.connection, AbortSignal.timeout(2000))), "legacy")
    // An unreachable or failing daemon must not look like stale legacy credentials.
    await assert.rejects(readUsageCredentials(failing.connection, AbortSignal.timeout(2000)))
  } finally {
    await Promise.all([current.close(), missing.close(), failing.close()])
    if (previous === undefined) delete process.env.OPENCODE_AUTH_FILE
    else process.env.OPENCODE_AUTH_FILE = previous
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
