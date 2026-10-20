import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { extraProviders } from "./extra"

async function withIsolatedFetch(run: () => Promise<void>): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-extra-usage-"))
  const previousFetch = globalThis.fetch
  const previousClaudeDir = process.env.CLAUDE_CONFIG_DIR
  // Never read the developer's real Claude Code login.
  process.env.CLAUDE_CONFIG_DIR = directory
  try {
    await run()
  } finally {
    globalThis.fetch = previousFetch
    if (previousClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousClaudeDir
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test("rejects an empty CrofAI usage payload", async () => {
  await withIsolatedFetch(async () => {
    for (const payload of [{}, { credits: "invalid" }]) {
      globalThis.fetch = async () => Response.json(payload)
      const usage = await extraProviders.find((provider) => provider.id === "crof")!.fetchQuota({ crof: { key: "token" } })
      assert.equal(usage.ok, false)
      assert.match(usage.error ?? "", /no quota data/)
    }
  })
})

test("rejects an empty Claude usage payload", async () => {
  await withIsolatedFetch(async () => {
    for (const payload of [{}, { limits: [{ kind: "session", percent: "invalid" }] }]) {
      globalThis.fetch = async () => Response.json(payload)
      const usage = await extraProviders.find((provider) => provider.id === "claude")!
        .fetchQuota({ claude: { type: "oauth", access: "token", expires: Date.now() + 3_600_000 } })
      assert.equal(usage.ok, false)
      assert.match(usage.error ?? "", /no quota data/)
    }
  })
})
