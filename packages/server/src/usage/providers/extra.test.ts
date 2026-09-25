import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { extraProviders } from "./extra"

async function withAuth(auth: Record<string, unknown>, run: () => Promise<void>): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-extra-usage-"))
  const authFile = path.join(directory, "auth.json")
  const previousAuthFile = process.env.OPENCODE_AUTH_FILE
  const previousFetch = globalThis.fetch
  fs.writeFileSync(authFile, JSON.stringify(auth))
  process.env.OPENCODE_AUTH_FILE = authFile
  try {
    await run()
  } finally {
    globalThis.fetch = previousFetch
    if (previousAuthFile === undefined) delete process.env.OPENCODE_AUTH_FILE
    else process.env.OPENCODE_AUTH_FILE = previousAuthFile
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test("rejects an empty CrofAI usage payload", async () => {
  await withAuth({ crof: { key: "token" } }, async () => {
    for (const payload of [{}, { credits: "invalid" }]) {
      globalThis.fetch = async () => Response.json(payload)
      const usage = await extraProviders.find((provider) => provider.id === "crof")!.fetchQuota()
      assert.equal(usage.ok, false)
      assert.match(usage.error ?? "", /no quota data/)
    }
  })
})

test("rejects an empty Claude usage payload", async () => {
  await withAuth({ claude: { type: "oauth", access: "token", expires: Date.now() + 3_600_000 } }, async () => {
    for (const payload of [{}, { limits: [{ kind: "session", percent: "invalid" }] }]) {
      globalThis.fetch = async () => Response.json(payload)
      const usage = await extraProviders.find((provider) => provider.id === "claude")!.fetchQuota()
      assert.equal(usage.ok, false)
      assert.match(usage.error ?? "", /no quota data/)
    }
  })
})
