import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import test from "node:test"
import { OpenCode, type CredentialEntry } from "@opencode/client"
import type { ServiceConnection } from "../workspaces/opencode-service"
import { openCodeConsoleCredential, projectCredential, projectCredentials, readUsageCredentials } from "./native-credentials"

const entries: CredentialEntry[] = [
  { id: "a", integrationID: "deepinfra", label: "Key", active: true, value: { type: "key", key: "secret-key", metadata: { note: "x" } } },
  { id: "b", integrationID: "anthropic", label: "Old", active: false, value: { type: "key", key: "inactive" } },
  { id: "c", integrationID: "anthropic", label: "Pro", active: true,
    value: { type: "oauth", methodID: "claude", access: "secret-access", refresh: "secret-refresh", expires: 42, metadata: { accountID: "acct", email: "a@b.c" } } },
  { id: "external", integrationID: "azure", label: "CLI reference", active: true,
    value: { type: "external", methodID: "azure-cli", metadata: { resource: "fixture-only" } } },
]

test("projects only each integration's active native credential, without unrelated metadata", () => {
  assert.deepEqual(projectCredentials(entries), {
    deepinfra: { type: "api", key: "secret-key" },
    anthropic: { type: "oauth", methodID: "claude", access: "secret-access", refresh: "secret-refresh", expires: 42, accountId: "acct" },
  })
})

test("Google's server-only projection keeps its client method and complete selected-credential identity", () => {
  const value = { type: "oauth" as const, methodID: "gemini-cli", access: "fake-google-access", refresh: "fake-google-refresh|fake-project",
    expires: 42, metadata: { email: "fake@example.invalid", project: "fake-metadata" } }
  const entry: CredentialEntry = { id: "fake-google-identity", integrationID: "google", label: "default", active: true, value }
  assert.deepEqual(projectCredential(entry), { ...value, credentialID: entry.id })
})

test("projects only Copilot's raw enterprise destination metadata, retaining invalid values for rejection", () => {
  for (const enterpriseUrl of ["company.ghe.com", "https://github.example.com/", "https://user@company.ghe.com", "", null, 443]) {
    const entry: CredentialEntry = { id: "copilot", integrationID: "github-copilot", active: true, label: "Enterprise",
      value: { type: "oauth", methodID: "device", access: "synthetic", refresh: "synthetic", expires: 0,
        metadata: { enterpriseUrl, apiEndpoint: "https://unrelated.example.com", unrelated: "omit" } } }
    assert.deepEqual(projectCredential(entry), { type: "oauth", methodID: "device", access: "synthetic", refresh: "synthetic", expires: 0, enterpriseUrl })
    assert.equal(projectCredential({ ...entry, integrationID: "anthropic" })?.enterpriseUrl, undefined)
  }
})

test("Console OAuth wins over a key in either native entry order; other integrations keep native ordering", () => {
  const key: CredentialEntry = { id: "key", integrationID: "opencode", active: true, label: "Key", value: { type: "key", key: "fake-key" } }
  const oauth: CredentialEntry = { id: "oauth", integrationID: "opencode", active: true, label: "OAuth",
    value: { type: "oauth", methodID: "device", access: "fake-access", refresh: "fake-refresh", expires: Date.now() + 3600000,
      metadata: { orgID: "org_fixture", server: "https://opencode.ai/console" } } }
  for (const entries of [[key, oauth], [oauth, key], [oauth]]) {
    assert.deepEqual(openCodeConsoleCredential(projectCredentials(entries)), {
      headers: { Authorization: "Bearer fake-access", "x-org-id": "org_fixture" },
    })
  }
  assert.deepEqual(openCodeConsoleCredential(projectCredentials([key])), { headers: { Authorization: "Bearer fake-key" } })
  const expired = { ...oauth, value: { ...oauth.value, expires: 1 } } as CredentialEntry
  for (const entries of [[key, expired], [expired, key]]) {
    assert.deepEqual(openCodeConsoleCredential(projectCredentials(entries)), { reason: "opencode-console-invalid-credential", configured: true })
  }
  assert.equal((projectCredentials([oauth, { ...key, integrationID: "other" }]).other as { key: string }).key, "fake-key")
  const thirdParty = { ...key, value: { ...key.value, metadata: { server: "https://other.invalid" } } } as CredentialEntry
  assert.deepEqual(openCodeConsoleCredential(projectCredentials([thirdParty])), { reason: "opencode-console-invalid-credential", configured: true })
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

test("reads native credentials; a missing or failing API never substitutes host credentials", async () => {
  const current = await daemon(200)
  const missing = await daemon(404)
  const failing = await daemon(500)
  try {
    const key = (auth: Record<string, unknown>) => (auth.deepinfra as { key?: string } | undefined)?.key
    assert.equal(key(await readUsageCredentials(current.connection, AbortSignal.timeout(2000))), "secret-key")
    await assert.rejects(readUsageCredentials(missing.connection, AbortSignal.timeout(2000)))
    await assert.rejects(readUsageCredentials(failing.connection, AbortSignal.timeout(2000)))
  } finally {
    await Promise.all([current.close(), missing.close(), failing.close()])
  }
})
