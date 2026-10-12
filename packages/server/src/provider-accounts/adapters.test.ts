import assert from "node:assert/strict"
import test from "node:test"
import type { CredentialEntry } from "@opencode/client"
import { adapterForProvider, createSelectionAdapters } from "./adapters"
import { quotaState } from "./service"
import { ProviderHttpError } from "../usage/shared"
import type { AuthFile, ProviderResult, ProviderUsage } from "../usage/types"
import { openCodeGoAuth } from "../usage/providers/special"

const hour = 3_600_000
const window = (usedPercent: number | null, windowSeconds: number | null = 18_000) =>
  ({ usedPercent, remainingPercent: usedPercent === null ? null : 100 - usedPercent, windowSeconds, resetAt: Date.now() + hour })
const key = (integrationID: string, id: string, secret = `secret-${id}`, metadata?: Record<string, string>): CredentialEntry =>
  ({ id, integrationID, label: id, active: false, value: { type: "key", key: secret, ...(metadata ? { metadata } : {}) } })
const oauth = (integrationID: string, id: string, methodID: string, expires = Date.now() + hour, metadata: Record<string, string> = {}): CredentialEntry =>
  ({ id, integrationID, label: "default", active: false,
    value: { type: "oauth", methodID, access: `secret-access-${id}`, refresh: `secret-refresh-${id}`, expires, metadata } })

function harness() {
  const go: Array<{ token: string; orgID?: string }> = []
  const usage: Array<{ integrationID: string; auth: AuthFile }> = []
  let reply: (integrationID: string, auth: AuthFile) => ProviderResult = () => ({ providerId: "x", providerName: "x", ok: true,
    configured: true, fetchedAt: Date.now(), usage: { windows: { "5h": window(10) } } })
  const adapters = createSelectionAdapters({
    codexQuota: async () => ({ windows: {} }),
    goQuota: async auth => { go.push(auth); return { windows: { "5h": window(20) } } },
    usage: async (integrationID, auth) => { usage.push({ integrationID, auth }); return reply(integrationID, auth) },
  })
  return { adapters, go, usage, setReply: (next: typeof reply) => { reply = next } }
}
const signal = () => AbortSignal.timeout(2000)

test("registry covers subscription integrations only, with Go restricted to its provider", () => {
  const { adapters } = harness()
  assert.deepEqual([...adapters.keys()].sort(), ["anthropic", "github-copilot", "kimi-for-coding", "minimax-cn-coding-plan",
    "minimax-coding-plan", "openai", "opencode", "opencode-go", "zai-coding-plan", "zhipuai-coding-plan"])
  for (const payAsYouGo of ["openrouter", "deepinfra", "zai", "minimax", "deepseek", "kilo", "zenmux", "cursor"]) {
    assert.equal(adapterForProvider(adapters, { id: payAsYouGo }), undefined)
  }
  assert.equal(adapterForProvider(adapters, { id: "opencode-go", integrationID: "opencode" })?.integrationID, "opencode")
  assert.equal(adapterForProvider(adapters, { id: "opencode", integrationID: "opencode" }), undefined, "Zen pay-as-you-go never rotates")
  assert.equal(adapterForProvider(adapters, { id: "go-alias", integrationID: "opencode", canonical: "opencode-go" })?.integrationID, "opencode")
  assert.equal(adapterForProvider(adapters, { id: "opencode-go" })?.integrationID, "opencode-go")
  assert.equal(adapterForProvider(adapters, { id: "claude-sonnet", integrationID: "anthropic" })?.integrationID, "anthropic")
  assert.deepEqual([...adapters.values()].filter(adapter => adapter.reactive).map(adapter => adapter.integrationID).sort(),
    ["anthropic", "opencode", "opencode-go"])
})

test("Go key and Console credentials read with their own explicit token and organization", async () => {
  const h = harness()
  const goKey = h.adapters.get("opencode-go")!.credential(key("opencode-go", "k2"))!
  assert.equal(quotaState(await goKey.read(signal())), "available")
  const consoleKey = h.adapters.get("opencode")!.credential(key("opencode", "svc", "secret-svc", { orgID: "org_a" }))!
  await consoleKey.read(signal())
  const signedIn = h.adapters.get("opencode")!.credential(oauth("opencode", "acct", "device", Date.now() + hour,
    { orgID: "org_b", email: "dev@example.com", server: "https://opencode.ai/console" }))!
  assert.equal(signedIn.login, "dev@example.com")
  await signedIn.read(signal())
  assert.deepEqual(h.go, [{ token: "secret-k2" }, { token: "secret-svc", orgID: "org_a" }, { token: "secret-access-acct", orgID: "org_b" }])
  for (const credential of [goKey, consoleKey, signedIn]) {
    assert.match(credential.identity, /^[0-9a-f]{64}$/)
    assert.equal(JSON.stringify(credential).includes("secret"), false)
  }
})

test("expiring Console tokens and self-hosted Console servers stay unread instead of refreshed", async () => {
  const h = harness()
  const adapter = h.adapters.get("opencode")!
  const expiring = adapter.credential(oauth("opencode", "old", "device", Date.now() + 30_000))!
  const selfHosted = adapter.credential(oauth("opencode", "self", "device", Date.now() + hour, { server: "https://console.example.com" }))!
  await assert.rejects(expiring.read(signal()))
  await assert.rejects(selfHosted.read(signal()))
  // Service-account keys carry the same Console server: never send a self-hosted key to opencode.ai.
  for (const server of ["https://console.example.com", "not a url", ""]) {
    const selfHostedKey = adapter.credential(key("opencode", "svc-self", "secret-self-key", { server, orgID: "org_self" }))!
    await assert.rejects(selfHostedKey.read(signal()), error => !(error instanceof ProviderHttpError))
  }
  assert.equal(h.go.length, 0)
  assert.deepEqual(openCodeGoAuth({ opencode: { type: "api", key: "k", server: "https://opencode.ai/console", orgId: "org" } }), { token: "k", orgID: "org" })
  assert.equal(openCodeGoAuth({ opencode: { type: "api", key: "k", server: "https://console.example.com" } }), null)
  assert.equal(adapter.credential(oauth("opencode", "other", "browser")), null)
  assert.equal(adapter.credential({ ...key("opencode", "blank"), value: { type: "key", key: " " } }), null)
  assert.equal(h.adapters.get("opencode-go")!.credential(key("opencode", "foreign")), null)
})

test("usage-backed adapters project one explicit inactive credential into the existing reader", async () => {
  const h = harness()
  const claude = h.adapters.get("anthropic")!.credential(oauth("anthropic", "max", "claude", Date.now() + hour, { email: "max@example.com" }))!
  assert.equal(claude.login, "max@example.com")
  assert.equal(quotaState(await claude.read(signal())), "available")
  const zai = h.adapters.get("zai-coding-plan")!.credential(key("zai-coding-plan", "plan"))!
  await zai.read(signal())
  assert.deepEqual(h.usage.map(call => call.integrationID), ["anthropic", "zai-coding-plan"])
  assert.deepEqual(Object.keys(h.usage[0].auth), ["anthropic"])
  assert.equal((h.usage[0].auth.anthropic as { access: string }).access, "secret-access-max")
  assert.deepEqual(h.usage[1].auth, { "zai-coding-plan": { type: "api", key: "secret-plan" } })
  // Keys are not OAuth subscriptions for Claude/Copilot, and OAuth is not a coding-plan key.
  assert.equal(h.adapters.get("anthropic")!.credential(key("anthropic", "console")), null)
  assert.equal(h.adapters.get("kimi-for-coding")!.credential(oauth("kimi-for-coding", "o", "x")), null)
})

test("unreadable, expired and rejected readings are never availability evidence", async () => {
  const h = harness()
  const claude = h.adapters.get("anthropic")!.credential(oauth("anthropic", "expired", "claude", Date.now() - hour))!
  h.setReply(() => ({ providerId: "claude", providerName: "Claude", ok: false, configured: true, fetchedAt: Date.now(), usage: null,
    error: "Claude session expired." }))
  await assert.rejects(claude.read(signal()), error => !(error instanceof ProviderHttpError))
  h.setReply(() => ({ providerId: "claude", providerName: "Claude", ok: false, configured: true, fetchedAt: Date.now(), usage: null, status: 401 }))
  await assert.rejects(claude.read(signal()), error => error instanceof ProviderHttpError && error.status === 401)
  const enterprise = h.adapters.get("github-copilot")!.credential(oauth("github-copilot", "ghe", "device", 0, { enterpriseUrl: "ghe.example.com" }))!
  const calls = h.usage.length
  await assert.rejects(enterprise.read(signal()))
  assert.equal(h.usage.length, calls, "enterprise tokens are never sent to github.com")
})

test("default readers send the candidate's own credential to the existing Usage endpoints", async () => {
  const previous = globalThis.fetch
  const requests: Array<{ url: string; authorization: string | null }> = []
  const resetAt = new Date(Date.now() + hour).toISOString()
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    requests.push({ url, authorization: new Headers(init?.headers).get("authorization") })
    if (url.includes("api.z.ai")) return new Response(JSON.stringify({ data: { limits: [
      { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 100, nextResetTime: resetAt },
      { type: "TIME_LIMIT", percentage: 0, nextResetTime: resetAt },
    ] } }))
    if (url.includes("api.anthropic.com")) {
      return new Headers(init?.headers).get("authorization") === "Bearer secret-access-gone"
        ? new Response("{}", { status: 404 })
        : new Response(JSON.stringify({ limits: [{ kind: "session", percent: 15, resets_at: resetAt }] }))
    }
    if (url.includes("api.minimax.io")) return new Response("{}", { status: 402 })
    return new Response("{}", { status: 404 })
  }
  try {
    const adapters = createSelectionAdapters()
    const zai = adapters.get("zai-coding-plan")!.credential(key("zai-coding-plan", "spare", "fixture-zai-key"))!
    assert.equal(quotaState(await zai.read(signal())), "exhausted")
    const claude = adapters.get("anthropic")!.credential(oauth("anthropic", "spare", "claude"))!
    assert.equal(quotaState(await claude.read(signal())), "available")
    assert.deepEqual(requests, [
      { url: "https://api.z.ai/api/monitor/usage/quota/limit", authorization: "Bearer fixture-zai-key" },
      { url: "https://api.anthropic.com/api/oauth/usage", authorization: "Bearer secret-access-spare" },
    ])
    // Readers keep definite HTTP statuses so selection can rule the account out.
    const gone = adapters.get("anthropic")!.credential(oauth("anthropic", "gone", "claude"))!
    await assert.rejects(gone.read(signal()), error => error instanceof ProviderHttpError && error.status === 404)
    const minimax = adapters.get("minimax-coding-plan")!.credential(key("minimax-coding-plan", "lapsed"))!
    await assert.rejects(minimax.read(signal()), error => error instanceof ProviderHttpError && error.status === 402)
  } finally { globalThis.fetch = previous }
})

test("selection views keep only plan windows with positive durations", async () => {
  const h = harness()
  const read = async (integrationID: string, windows: ProviderUsage["windows"], entry: CredentialEntry) => {
    h.setReply(() => ({ providerId: integrationID, providerName: integrationID, ok: true, configured: true, fetchedAt: Date.now(), usage: { windows } }))
    return (await h.adapters.get(integrationID)!.credential(entry)!.read(signal())).windows
  }
  const zai = await read("zai-coding-plan", { "5h": window(20), "mcp-tools": window(100, 2_592_000) }, key("zai-coding-plan", "z"))
  assert.deepEqual(Object.keys(zai), ["5h"])
  const copilot = await read("github-copilot", { chat: window(null, null), premium: window(100, null) }, oauth("github-copilot", "c", "device", 0))
  assert.deepEqual(Object.keys(copilot), ["premium"])
  assert.equal(copilot.premium.windowSeconds, 30 * 86_400)
  assert.equal(quotaState({ windows: copilot }), "exhausted")
  const kimi = await read("kimi-for-coding", { weekly: window(30, null), "5h": window(10) }, key("kimi-for-coding", "k"))
  assert.equal(kimi.weekly.windowSeconds, 7 * 86_400)
  const minimax = await read("minimax-coding-plan", { "5h": window(10, null) }, key("minimax-coding-plan", "m"))
  assert.equal(minimax["5h"].windowSeconds, 18_000)
  const claude = await read("anthropic", { "5h": window(10), extra_usage: window(90, null) }, oauth("anthropic", "a", "claude"))
  assert.equal(quotaState({ windows: claude }), "available")
})
