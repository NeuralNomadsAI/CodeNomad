import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { apiKeyProviders } from "./api-key"

const originalAuthFile = process.env.OPENCODE_AUTH_FILE
const createdAuthDirs: string[] = []

test.before(() => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-usage-auth-"))
  createdAuthDirs.push(authDir)
  fs.writeFileSync(
    path.join(authDir, "auth.json"),
    JSON.stringify({ "zai-coding-plan": { type: "api", key: "test-zai-key" }, "zhipuai-coding-plan": { type: "api", key: "test-zhipu-key" } }),
  )
  process.env.OPENCODE_AUTH_FILE = path.join(authDir, "auth.json")
})

test.after(() => {
  if (originalAuthFile === undefined) delete process.env.OPENCODE_AUTH_FILE
  else process.env.OPENCODE_AUTH_FILE = originalAuthFile
  const tmpRoot = fs.realpathSync(os.tmpdir())
  for (const dir of createdAuthDirs) {
    // Containment guard: never recurse outside the temp root we created.
    if (fs.realpathSync(path.dirname(dir)) === tmpRoot && path.basename(dir).startsWith("codenomad-usage-auth-")) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

const CREDIT_RESET_AT = 1787849891189
const TOKENS_RESET_AT = 1787950772998

function respondWith(payload: unknown) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } })
}

async function withFetchStub<T>(payload: unknown, run: () => Promise<T>): Promise<{ result: T; requestUrl: string | undefined }> {
  const original = globalThis.fetch
  let requestUrl: string | undefined
  globalThis.fetch = (async (input: any) => {
    requestUrl = String(input)
    return respondWith(payload)
  }) as typeof fetch
  try {
    return { result: await run(), requestUrl }
  } finally {
    globalThis.fetch = original
  }
}

const zai = apiKeyProviders.find((provider) => provider.id === "zai-coding-plan")!
const zhipu = apiKeyProviders.find((provider) => provider.id === "zhipuai-coding-plan")!

test("parses credit-based limits into usage windows", async () => {
  const { result } = await withFetchStub(
    {
      code: 200,
      msg: "Operation successful",
      success: true,
      data: {
        level: "lite",
        limits: [
          { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 2000, currentValue: 157, remaining: 1842, percentage: 7, nextResetTime: CREDIT_RESET_AT },
          { type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 10000, currentValue: 157, remaining: 9843, percentage: 1, nextResetTime: TOKENS_RESET_AT },
        ],
      },
    },
    () => zai.fetchQuota(),
  )

  assert.equal(result.ok, true)
  const windows = result.usage!.windows
  assert.equal(windows["5h"]?.usedPercent, 7)
  assert.equal(windows["5h"]?.windowSeconds, 18_000)
  assert.equal(windows["5h"]?.resetAt, CREDIT_RESET_AT)
  assert.equal(windows["usage"]?.usedPercent, 1)
  assert.equal("valueLabel" in (windows["usage"] ?? {}), false)
})

test("derives usedPercent when the credit payload omits percentage", async () => {
  const { result } = await withFetchStub(
    {
      data: { limits: [{ type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 2000, currentValue: 158, remaining: 1842, nextResetTime: CREDIT_RESET_AT }] },
    },
    () => zai.fetchQuota(),
  )

  const window = result.usage!.windows["usage"]
  // (2000 - 1842) / 2000
  assert.ok(Math.abs((window?.usedPercent ?? 0) - 7.9) < 0.001)
})

test("coerces string quota fields and skips unusable entries without throwing", async () => {
  const { result } = await withFetchStub(
    {
      data: {
        limits: [
          null,
          { type: "UNKNOWN_LIMIT" },
          { type: "CREDIT_LIMIT", unit: 6, number: 1, usage: "10000", remaining: "9800", percentage: "2", nextResetTime: TOKENS_RESET_AT },
        ],
      },
    },
    () => zai.fetchQuota(),
  )

  assert.equal(result.ok, true)
  const windows = result.usage!.windows
  assert.equal(Object.keys(windows).length, 1)
  assert.equal(windows["usage"]?.usedPercent, 2)
})

test("keeps legacy token and time windows intact for the bigmodel endpoint", async () => {
  const { result, requestUrl } = await withFetchStub(
    {
      data: {
        limits: [
          { type: "TOKENS_LIMIT", unit: 3, number: 1, percentage: 42, nextResetTime: TOKENS_RESET_AT },
          { type: "TIME_LIMIT", number: 1, percentage: 11 },
        ],
      },
    },
    () => zhipu.fetchQuota(),
  )

  assert.equal(requestUrl, "https://open.bigmodel.cn/api/monitor/usage/quota/limit")
  assert.equal(result.ok, true)
  const windows = result.usage!.windows
  assert.equal(windows["1h"]?.usedPercent, 42)
  assert.equal(windows["mcp-tools"]?.usedPercent, 11)
})
