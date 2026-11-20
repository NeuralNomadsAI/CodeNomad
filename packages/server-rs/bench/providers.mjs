// Mode `providers`: `GET /api/usage/:provider` per adapter against a fake provider. Every HTTPS
// request of both servers is rerouted to it (`https://host/path` → `<fake>/host/path`: TS patches
// `fetch` in ts-server.mjs, Rust reads `CNRS_FIXTURE_PROVIDERS`), so no real provider or account is
// ever reached. Credentials are synthetic, created in each isolated daemon; each scenario has its
// own token, so provider caches never mix scenarios. The fake answers by the scenario's routes and
// records what it received; times near now are scrubbed.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"

let fake, origin, scenario, received = []
const sockets = new Set()
const secrets = new Set()
const FAR = Date.UTC(2030, 0, 1), FAR_ISO = "2030-01-01T00:00:00.000Z", FAR_S = FAR / 1000
const b64 = value => Buffer.from(JSON.stringify(value)).toString("base64url")
const jwt = (claims, tag) => `${b64({ alg: "none" })}.${b64(claims)}.${tag}`
const secret = value => (secrets.add(value), value)
const digest = value => ({ sha256: createHash("sha256").update(value).digest("hex") })
const json = (body, status = 200, headers = {}) => ({ status, body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } })
export const secretsList = () => [...secrets]
export { secretsList as secrets }

/** The daemon's provider settings (OpenRouter's declared destination and key). */
export async function prepare({ root }) {
  const dir = path.join(root, "claude-code")
  await mkdir(dir)
  await writeFile(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
    accessToken: secret("tok-claude-code"), refreshToken: secret("ref-claude-code"), expiresAt: FAR } }))
  return { providers: {
    openrouter: { settings: { baseURL: "https://openrouter.example.test/api/v1", apiKey: secret("tok-openrouter-settings") } },
  } }
}

export async function configure() {
  fake = createServer((request, response) => {
    const chunks = []
    request.on("data", chunk => chunks.push(chunk))
    request.on("end", () => {
      const url = new URL(request.url, "http://fake")
      const [, host, ...rest] = url.pathname.split("/")
      const route = `${host}/${rest.join("/")}${url.search}`
      const body = Buffer.concat(chunks)
      const headers = Object.fromEntries(["authorization", "chatgpt-account-id", "x-org-id", "cookie", "content-type", "accept",
        "x-kilocode-organizationid", "anthropic-beta", "user-agent", "connect-protocol-version", "x-grpc-web", "origin", "referer",
        "editor-version", "x-github-api-version", "accept-encoding"].filter(name => request.headers[name] !== undefined).map(name => [name, request.headers[name]]))
      if (!headers["accept-encoding"] || headers["accept-encoding"].split(",").every(coding => ["gzip", "deflate", "br"].includes(coding.trim())))
        delete headers["accept-encoding"] // Runtime transport default; compare explicit identity.
      for (const key of ["authorization", "cookie", "chatgpt-account-id", "x-org-id"])
        if (headers[key] !== undefined) headers[key] = digest(headers[key])
      received.push({ method: request.method, route, headers, body: body.length
        ? (host === "oauth2.googleapis.com" ? digest(body) : body.toString("base64")) : undefined })
      const answer = scenario?.routes?.[route] ?? scenario?.routes?.[`${host}/${rest.join("/")}`]
      const reply = typeof answer === "function" ? answer({ body: body.toString(), headers: request.headers }) : answer
      if (!reply) { response.writeHead(404, { "content-type": "application/json" }); return response.end("{\"error\":\"fixture\"}") }
      response.writeHead(reply.status ?? 200, reply.headers ?? {})
      response.end(reply.raw ?? reply.body ?? "")
    })
  })
  fake.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)) })
  await new Promise(resolve => fake.listen(0, "127.0.0.1", resolve))
  origin = `http://127.0.0.1:${fake.address().port}`
  return ""
}
export async function close() {
  for (const socket of sockets) socket.destroy()
  await new Promise(resolve => fake ? fake.close(resolve) : resolve())
}

/** Both servers' environment: the reroute, then every variable an adapter reads, synthetic or empty. */
export const environment = root => ({
  CNRS_FIXTURE_PROVIDERS: origin, CLAUDE_CONFIG_DIR: path.join(root, "claude-code"), CLAUDE_CODE_OAUTH_TOKEN: "", CLAUDE_SECURESTORAGE_CONFIG_DIR: undefined,
  CURSOR_ACCESS_TOKEN: secret("tok-cursor"), CURSOR_TOKEN: "", OLLAMA_CLOUD_COOKIE: secret("session=tok-ollama"),
  ZENMUX_PLATFORM_API_KEY: secret("tok-zenmux"), EXE_DEV_USAGE_TOKEN: secret("tok-exe"), COMMAND_CODE_API_KEY: "",
  OPENCODE_GO_WORKSPACE_ID: "", OPENCODE_GO_AUTH_COOKIE: "",
})

const key = token => ({ type: "key", key: secret(token) })
const oauth = (methodID, access, extra = {}) => ({ type: "oauth", methodID, access: secret(access), refresh: secret(`ref-${access}`), expires: FAR, ...extra })

/** [label, providerId, modelId, credentials ([integrationID, value]), routes]. */
const SCENARIOS = [
  ["unknown", "not-a-provider", undefined, [], {}],
  ["copilot", "github-copilot", undefined, [["github-copilot", oauth("oauth", "tok-copilot")]], {
    "api.github.com/copilot_internal/user": json({ copilot_plan: "individual_pro", quota_reset_date_utc: FAR_ISO, quota_snapshots: {
      chat: { unlimited: true, has_quota: true, credits_used: 3 },
      completions: { entitlement: 0 },
      premium_interactions: { entitlement: 300, quota_remaining: 75.5, percent_remaining: 25.1666, quota_reset_at: FAR_S } } }),
  }],
  ["copilot-enterprise", "copilot", undefined, [["github-copilot", oauth("oauth", "tok-copilot-ent", { metadata: { enterpriseUrl: "ghe.example.test" } })]], {
    "api.ghe.example.test/copilot_internal/user": json({ access_type_sku: "free_limited_copilot", quota_snapshots: { chat: { entitlement: 50, quota_remaining: 50 } } }),
  }],
  ["copilot-bad-url", "github-copilot", undefined, [["github-copilot", oauth("oauth", "tok-copilot-bad", { metadata: { enterpriseUrl: "https://10.0.0.1:8443/x" } })]], {}],
  ["copilot-500", "github-copilot", undefined, [["github-copilot", oauth("oauth", "tok-copilot-500")]], { "api.github.com/copilot_internal/user": json({ secret: "x" }, 500) }],
  ["copilot-redirect", "github-copilot", undefined, [["github-copilot", oauth("oauth", "tok-copilot-redirect")]], {
    "api.github.com/copilot_internal/user": () => json({}, 302, { location: `${origin}/forbidden/followed` }),
  }],
  ["copilot-too-large", "github-copilot", undefined, [["github-copilot", oauth("oauth", "tok-copilot-limit")]], {
    "api.github.com/copilot_internal/user": json({ pad: "a".repeat(65_536) }),
  }],
  ["kimi", "kimi-for-coding", undefined, [["kimi-for-coding", key("tok-kimi")]], {
    "api.kimi.com/coding/v1/usages": json({ usage: { limit: "200", remaining: 150, resetTime: FAR_ISO },
      limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: 100, remaining: 40, resetTime: FAR_ISO } }],
      usages: { limit_5h: { used_ratio: 0.25, reset_time: FAR_ISO }, limit_month_code: { used_ratio: 1.5 } } }),
  }],
  ["nano", "nano-gpt", undefined, [["nano-gpt", key("tok-nano")]], {
    "nano-gpt.com/api/subscription/v1/usage": json({ daily: { used: 5, limit: 50 }, monthly: { percentUsed: 0.125 }, period: { currentPeriodEnd: FAR_ISO } }),
  }],
  ["openrouter", "openrouter", undefined, [["openrouter", key("tok-openrouter")]], {
    "openrouter.example.test/api/v1/key": json({ data: { limit: 20, limit_remaining: 7.5 } }),
    "openrouter.example.test/api/v1/credits": json({ data: { total_credits: 50, total_usage: 12.25 } }),
  }],
  ["zai", "zai-coding-plan", undefined, [["zai-coding-plan", key("tok-zai")]], {
    "api.z.ai/api/monitor/usage/quota/limit": json({ code: 200, success: true, data: { limits: [
      { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 42, nextResetTime: FAR },
      { type: "TIME_LIMIT", percentage: 10 }, { type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 1000, remaining: 250 }] } }),
  }],
  ["zhipu-error", "zhipuai-coding-plan", undefined, [["zhipuai-coding-plan", key("tok-zhipu")]], {
    "open.bigmodel.cn/api/monitor/usage/quota/limit": json({ code: 1001, success: false, msg: "tok-zhipu" }),
  }],
  ["wafer", "wafer", undefined, [["wafer", key("tok-wafer")]], {
    "pass.wafer.ai/v1/inference/quota": json({ remaining_included_requests: 80, included_request_limit: 100, current_period_used_percent: 20,
      window_start: "2029-12-31T19:00:00Z", window_end: FAR_ISO }),
  }],
  ["cline", "cline-pass", undefined, [["cline-pass", key("tok-cline")]], {
    "api.cline.bot/api/v1/users/me/plan/usage-limits": json({ data: { limits: [{ type: "five_hour", percentUsed: 33.3333, resetsAt: FAR_ISO }, { type: "weekly", percentUsed: "7" }, { type: "other", percentUsed: 1 }] } }),
  }],
  ["deepinfra", "deepinfra", undefined, [["deepinfra", key("tok-deepinfra")]], {
    "api.deepinfra.com/v1/me?checklist=true": json({ checklist: { stripe_balance: "-12.345" } }),
  }],
  ["hyper", "hyper", undefined, [["hyper", key("tok-hyper")]], { "hyper.charm.land/v1/credits": json({ balance: 1234.5 }) }],
  ["kilo", "kilo", undefined, [["kilo", { ...key("tok-kilo"), metadata: { orgID: "org_kilo" } }]], { "api.kilo.ai/api/profile/balance": json({ balance: -0.125 }) }],
  ["zenmux", "zenmux", undefined, [], { "zenmux.ai/api/v1/management/payg/balance": json({ data: { total_credits: 3.005 } }) }],
  ["exe", "exe-dev", undefined, [], { "exe.dev/exec": json({ total_cost_usd: 12.5, monthly_allowance_usd: 50, period_end: FAR_ISO }) }],
  ["command-code", "command-code", undefined, [["command-code", key("tok-command")]], {
    "api.commandcode.ai/alpha/whoami": json({ org: { id: " org 1 " } }),
    "api.commandcode.ai/alpha/billing/credits?orgId=org%201": json({ credits: { monthlyCredits: 10.005, freeCredits: 0 },
      windowLimits: { fiveHour: { used: 5, cap: 20, resetAt: FAR_S }, weekly: { used: 1, cap: 0 } } }),
  }],
  ["deepseek", "deepseek", undefined, [["deepseek", key("tok-deepseek")]], {
    "api.deepseek.com/user/balance": json({ balance_infos: [{ currency: "CNY", total_balance: "88.5" }] }),
  }],
  ["neuralwatt", "neuralwatt", undefined, [["neuralwatt", key("tok-neuralwatt")]], {
    "api.neuralwatt.com/v1/quota": json({ subscription: { plan: " pro ", kwh_included: 10, kwh_used: 2.5, kwh_reset_date: FAR_ISO },
      key: { allowance: { spent_usd: 4, limit_usd: 10, period: "month", reset_at: FAR_ISO } }, balance: { credits_remaining_usd: 5 } }),
  }],
  ["minimax", "minimax", undefined, [["minimax-coding-plan", key("tok-minimax")]], {
    "api.minimax.io/v1/token_plan/remains": json({ base_resp: { status_code: 1004 } }),
    "api.minimax.io/v1/api/openplatform/coding_plan/remains": json({ base_resp: { status_code: 0 }, model_remains: [
      { model_name: "MiniMax-M2", current_interval_total_count: 100, current_interval_usage_count: 30, start_time: FAR - 18_000_000, end_time: FAR,
        current_weekly_total_count: 1000, current_weekly_usage_count: 100, weekly_remains_time: 86_400_000, weekly_end_time: FAR }] }),
  }],
  ["minimax-cn", "minimax-cn-coding-plan", undefined, [["minimax-cn-coding-plan", key("tok-minimaxi")]], {
    "api.minimaxi.com/v1/token_plan/remains": json({ base_resp: { status_code: 0 }, model_remains: [] }),
    "www.minimaxi.com/v1/api/openplatform/coding_plan/remains": json({ base_resp: { status_code: 0 }, model_remains: [] }),
  }],
  ["claude", "anthropic", "claude-opus-4-1", [["anthropic", oauth("oauth", "tok-claude")]], {
    "api.anthropic.com/api/oauth/usage": json({ limits: [
      { kind: "session", percent: 12, resets_at: FAR_ISO }, { kind: "weekly_all", percent: "40", resets_at: FAR_S },
      { kind: "weekly_scoped", percent: 70, scope: { model: { display_name: "Opus 4.1" } } }],
      spend: { enabled: true, percent: 5, used: { amount_minor: 1234, currency: "EUR" }, limit: { amount_minor: 50000 } } }),
  }],
  ["claude-429", "claude", undefined, [["anthropic", oauth("oauth", "tok-claude-429")]], {
    "api.anthropic.com/api/oauth/usage": json({}, 429, { "retry-after": "120" }),
  }],
  ["claude-code", "claude-agent", undefined, [], {
    "api.anthropic.com/api/oauth/usage": json({ five_hour: { utilization: 25.5, resets_at: FAR_ISO }, seven_day: { utilization: "60" } }),
  }],
  ["google", "google", "gemini-2.5-pro", [["google", oauth("gemini-cli", "tok-google-old", { expires: 1000, refresh: secret("ref-google|proj-fixture") })]], {
    "oauth2.googleapis.com/token": json({ access_token: secret("tok-google-new"), expires_in: 3600 }),
    "cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota": json({ buckets: [
      { modelId: "gemini-2.5-pro", tokenType: "REQUESTS", remainingFraction: 0.75, resetTime: FAR_ISO },
      { modelId: "gemini-2.5-flash", remainingFraction: 0.5 }, { modelId: "other-model", remainingFraction: 0.1 }] }),
  }],
  ["antigravity", "google", undefined, [["google", oauth("antigravity", "tok-antigravity", { refresh: secret("ref-anti||proj-managed") })]], {
    "daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary": json({ groups: [
      { displayName: "Gemini models", buckets: [{ window: "5h", remaining: { remainingFraction: 0.4, resetTime: "2030-01-01T00:00:00Z" } }, { window: "weekly", remainingFraction: 1 }] },
      { displayName: "Claude and GPT models", buckets: [{ window: "weekly", remainingFraction: 0.9, disabled: false }] },
      { displayName: "Unknown", buckets: [{ window: "5h", remainingFraction: 0 }] }] }),
  }],
  ["xai", "grok", undefined, [["xai", oauth("oauth", jwt({ exp: FAR_S }, "tok-xai"))]], {
    "grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig": () => {
      const float = Buffer.alloc(4); float.writeFloatLE(37.5)
      const reset = [] // varint of FAR_S
      for (let v = FAR_S; ; v = Math.floor(v / 128)) { if (v < 128) { reset.push(v); break } reset.push((v % 128) | 0x80) }
      const inner = Buffer.from([0x0d, ...float, 0x28, ...reset])
      const message = Buffer.from([0x0a, inner.length, ...inner])
      const frame = Buffer.concat([Buffer.from([0, 0, 0, 0, message.length]), message])
      const trailer = Buffer.from("grpc-status: 0\r\n")
      return { status: 200, headers: { "content-type": "application/grpc-web+proto" },
        raw: Buffer.concat([frame, Buffer.from([0x80, 0, 0, 0, trailer.length]), trailer]) }
    },
  }],
  ["cursor", "cursor", undefined, [], {
    "api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage": json({ planUsage: { limit: 2000, remaining: 500, totalSpend: 1234 }, billingCycleEnd: FAR_ISO }),
    "api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo": json({}),
  }],
  ["ollama", "ollama-cloud", undefined, [], {
    "ollama.com/settings": { status: 200, headers: { "content-type": "text/html" }, body: "<p>Session usage: 12.5%</p><p>Weekly usage 40%</p><p>Premium 3 / 20</p>" },
  }],
  ["opencode-go", "opencode-go", undefined, [["opencode-go", key("tok-go")]], {
    "opencode.ai/zen/go/v1/usage": json({ usage: { rolling: { status: "ok", percent: 12, resetsAt: FAR_ISO }, weekly: { status: "rate-limited", percent: 99 } } }),
  }],
  ["opencode-go-expired", "opencode-go", undefined, [["opencode-go", key("tok-go-expired")]], {
    "opencode.ai/zen/go/v1/usage": json({ error: { code: "api_key_expired", message: "tok-go-expired" } }, 401),
  }],
  ["console", "opencode", "claude-sonnet-4", [["opencode", key("tok-console")]], {
    "opencode.ai/console/api/usage/summary?range=24h": json(summary(3)), "opencode.ai/console/api/usage/summary?range=7d": json(summary(12)),
    "opencode.ai/console/api/usage/summary?range=30d": json(summary(40)),
    "opencode.ai/console/api/usage/models?range=30d&page=1&pageSize=50": json(modelsPage([["opencode", "big-pickle", 5], ["anthropic", "claude-sonnet-4", 35]])),
    "opencode.ai/console/api/billing/status": json({ availableMicroCents: "1250000000" }),
  }],
  ["console-free", "opencode", "big-pickle", [["opencode", key("tok-console-free")]], {
    "opencode.ai/console/api/usage/models?range=24h&page=1&pageSize=50": json(modelsPage([["opencode", "big-pickle", 5], ["x", "glm-free", 7], ["y", "paid", 9]])),
    "opencode.ai/console/api/billing/status": json({ availableMicroCents: "nope" }),
  }],
  ["console-denied", "opencode-console", undefined, [["opencode", key("tok-console-403")]], {
    "opencode.ai/console/api/usage/summary?range=24h": json({}, 403),
    "opencode.ai/console/api/billing/status": json({}, 403),
  }],
  ["codex", "openai", "gpt-5", [["openai", oauth("chatgpt-browser", jwt({ exp: FAR_S, "https://api.openai.com/auth": { chatgpt_account_id: "acct_fixture" } }, "tok-codex"))]], {
    "chatgpt.com/backend-api/wham/usage": json({ rate_limit: { primary_window: { limit_window_seconds: 18_000, used_percent: 12, reset_at: FAR_S },
      secondary_window: { limit_window_seconds: 604_800, used_percent: "50", reset_at: FAR_ISO } }, credits: { balance: "3.456" } }),
  }],
  ["codex-sharing", "openai", "gpt-5", [["openai", oauth("chatgpt-token-sharing", "tok-codex-sharing")]], {}],
]
function summary(requests) {
  const zero = { totalInputTokens: "0", totalOutputTokens: "0", totalCacheReadTokens: "0", totalCacheWrite5mTokens: "0", totalCacheWrite1hTokens: "0" }
  return { totalRequests: String(requests), ...zero, totalCostMicroCents: "250000000", services: [{ service: "zen", totalRequests: String(requests), totalCostMicroCents: "1" }] }
}
function modelsPage(rows) {
  const zero = { totalInputTokens: "0", totalOutputTokens: "0", totalCacheReadTokens: "0", totalCacheWrite5mTokens: "0", totalCacheWrite1hTokens: "0", totalCostMicroCents: "0" }
  return { pageInfo: { page: 1, pageSize: 50, total: rows.length, pageCount: 1 },
    items: rows.map(([provider, model, requests]) => ({ provider, model, totalRequests: String(requests), ...zero })) }
}

export async function run({ call, fixture, folder }) {
  const now = Date.now()
  const scrub = value => {
    if (Array.isArray(value)) return value.map(scrub)
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, k === "fetchedAt" ? typeof v : scrub(v)]))
    if (typeof value === "number" && Math.abs(value - now) < 3_600_000) return "<near now>"
    return value
  }
  const opened = await call("/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: folder }) })
  const workspace = await opened.json()
  for (let i = 0; i < 200 && (await (await call(`/api/workspaces/${workspace.id}`)).json()).status !== "ready"; i++) await delay(100)
  const session = await fixture.client.session.create({ location: { directory: workspace.path } })
  const usage = (provider, query) => call(`/api/usage/${encodeURIComponent(provider)}?${new URLSearchParams(query)}`, { signal: AbortSignal.timeout(30000) })
    .then(async response => ({ status: response.status, cache: response.headers.get("cache-control"), body: await response.json().catch(() => null) }))
  const out = { refusals: [] }
  for (const query of [{}, { instanceId: workspace.id }, { instanceId: workspace.id, sessionId: session.id, extra: "1" },
    { instanceId: "missing", sessionId: session.id }, { instanceId: workspace.id, sessionId: "ses_missing" }, { instanceId: workspace.id, sessionId: " " }])
    out.refusals.push(scrub(await usage("deepseek", query)))
  out.blank = scrub(await usage(" ", { instanceId: workspace.id, sessionId: session.id }))
  out.scenarios = {}
  for (const [label, providerId, modelId, credentials, routes] of SCENARIOS) {
    const created = []
    for (const [integrationID, value] of credentials) {
      try { created.push(await fixture.client.credential.create({ integrationID, label: `fixture ${label}`, value, activate: true })) }
      catch (error) { created.push({ error: String(error?._tag ?? error?.name ?? error) }) }
    }
    scenario = { routes }
    received = []
    const response = await usage(providerId, { instanceId: workspace.id, sessionId: session.id, ...(modelId ? { modelId } : {}) })
    const again = ["claude-429", "codex", "console", "console-free", "kimi"].includes(label)
      ? await usage(providerId, { instanceId: workspace.id, sessionId: session.id, ...(modelId ? { modelId } : {}) }) : undefined
    assert.equal(response.status, 200, label)
    assert.equal(response.cache, "no-store", label)
    assert(![...secrets].some(secret => JSON.stringify(response).includes(secret)), `Credential published by ${label}`)
    assert(created.every(c => !c.error), `${label}: fixture did not admit the synthetic credential`)
    assert.equal(received.length, Object.keys(routes).length, `${label}: not every fake route was read exactly once`)
    // The Console's optional balance read runs beside the ordered usage reads.
    const billing = received.filter(r => r.route === "opencode.ai/console/api/billing/status")
    const upstream = [...received.filter(r => !billing.includes(r)), ...billing]
    out.scenarios[label] = scrub({ credentials: created.map(c => c.error ?? "created"), response, again, upstream })
  }
  scenario = undefined
  await call(`/api/workspaces/${workspace.id}`, { method: "DELETE" })
  return out
}
