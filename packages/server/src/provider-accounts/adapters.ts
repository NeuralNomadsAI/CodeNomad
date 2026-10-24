import { createHash } from "node:crypto"
import type { CredentialEntry } from "@opencode/client"
import type { ProviderUsageWindow } from "../api-types"
import { codexCredential, displayLogin } from "../usage/codex-credential"
import { fetchCodexSelectionQuota } from "../usage/native-codex"
import { projectCredential } from "../usage/native-credentials"
import { fetchOpenCodeGoQuota, type OpenCodeGoAuth } from "../usage/opencode-go-quota"
import { createAnthropicClaudeUsage } from "../usage/providers/extra"
import { openCodeGoAuth } from "../usage/providers/special"
import { resolveUsageProvider } from "../usage/service"
import { getString, ProviderHttpError } from "../usage/shared"
import type { AuthFile, ProviderResult, ProviderUsage, UsageProvider } from "../usage/types"

/** Server-only: `read` closes over a native secret. Never log, cache or return it. */
export interface SelectionCredential {
  /** Irreversible digest; a changed digest fences a pending activation. */
  identity: string
  login?: string
  read(signal: AbortSignal): Promise<ProviderUsage>
}

export interface SelectionAdapter {
  integrationID: string
  /** Providers (native ID or canonical) this integration may rotate; omitted means every provider. */
  providers?: readonly string[]
  methods: readonly ("key" | "oauth")[]
  /**
   * Reactive adapters also accept a candidate whose quota is unknown unless a
   * recent native `provider.quota` failure marked it: their inactive
   * credentials are often unreadable (expired OAuth access, unverified API).
   * Others need a demonstrably "available" read.
   */
  reactive: boolean
  credential(entry: CredentialEntry, now?: number): SelectionCredential | null
}

export type SelectionAdapters = ReadonlyMap<string, SelectionAdapter>
type CodexQuota = (access: string, accountID: string, signal: AbortSignal) => Promise<ProviderUsage>
type GoQuota = (auth: OpenCodeGoAuth, signal: AbortSignal) => Promise<ProviderUsage>
type UsageReader = (integrationID: string, auth: AuthFile, signal: AbortSignal) => Promise<ProviderResult>

const MAX_SECRET_LENGTH = 16_384
const DAY_SECONDS = 86_400

export function createSelectionAdapters(options: { codexQuota?: CodexQuota; goQuota?: GoQuota; usage?: UsageReader } = {}): SelectionAdapters {
  const codexQuota = options.codexQuota ?? fetchCodexSelectionQuota
  const goQuota = options.goQuota ?? fetchOpenCodeGoQuota
  const usage = options.usage ?? readUsage
  const subscription = (input: Omit<SelectionAdapter, "credential"> & {
    select: (usage: ProviderUsage) => ProviderUsage
    readable?: (entry: CredentialEntry) => boolean
  }): SelectionAdapter => ({
    ...input,
    credential: entry => {
      const projected = eligible(input, entry) && projectCredential(entry)
      if (!projected) return null
      return {
        identity: digest([entry.integrationID, entry.id, projected]),
        ...login(entry),
        read: async signal => {
          if (input.readable && !input.readable(entry)) throw new Error("Quota unavailable")
          const result = await usage(input.integrationID, { [input.integrationID]: projected }, signal)
          if (!result.ok || !result.usage) throw result.status === undefined ? new Error("Quota unavailable") : new ProviderHttpError(result.status)
          return input.select(result.usage)
        },
      }
    },
  })
  const goSubscription = (integrationID: string, methods: SelectionAdapter["methods"]): SelectionAdapter => ({
    integrationID, providers: ["opencode-go"], methods, reactive: true,
    credential: entry => {
      const projected = eligible({ integrationID, methods }, entry) && projectCredential(entry)
      if (!projected || (entry.value.type === "oauth" && entry.value.methodID !== "device")) return null
      return {
        identity: digest([entry.integrationID, entry.id, projected]),
        ...login(entry),
        // Expiring Console tokens and self-hosted Console servers stay unread (unknown):
        // never refresh tokens or send them to opencode.ai.
        read: signal => {
          const auth = openCodeGoAuth({ [integrationID]: projected })
          return auth ? goQuota(auth, signal) : Promise.reject(new Error("Quota unavailable"))
        },
      }
    },
  })
  const adapters: SelectionAdapter[] = [
    {
      integrationID: "openai", methods: ["oauth"], reactive: false,
      credential: (entry, now) => {
        const credential = codexCredential(entry, now)
        return credential && { identity: credential.identity, login: credential.login,
          read: signal => codexQuota(credential.access, credential.accountID, signal) }
      },
    },
    // OpenCode Go API key; the usage endpoint is unverified upstream.
    goSubscription("opencode-go", ["key"]),
    // OpenCode Console sign-in also serves pay-as-you-go Zen without a quota: only Go rotates.
    goSubscription("opencode", ["oauth", "key"]),
    // Claude Pro/Max through OpenCode's Anthropic OAuth only, never the Claude Code login.
    // Inactive access tokens are usually expired and stay unread until OpenCode refreshes them.
    subscription({ integrationID: "anthropic", methods: ["oauth"], reactive: true,
      select: usage => ({ windows: usage.windows }) }),
    // Premium requests are the plan's limit; unlimited chat/completions are not evidence.
    subscription({ integrationID: "github-copilot", methods: ["oauth"], reactive: false,
      readable: entry => entry.value.metadata?.enterpriseUrl === undefined,
      select: usage => windows(usage, { fallbackSeconds: 30 * DAY_SECONDS, dropUnmeasured: true }) }),
    ...(["zai-coding-plan", "zhipuai-coding-plan"] as const).map(integrationID => subscription({
      integrationID, methods: ["key"], reactive: false,
      // MCP tool allowances do not block model requests.
      select: usage => windows(usage, { drop: ["mcp-tools"] }) })),
    subscription({ integrationID: "kimi-for-coding", methods: ["key"], reactive: false,
      select: usage => windows(usage, { defaults: { weekly: 7 * DAY_SECONDS } }) }),
    ...(["minimax-coding-plan", "minimax-cn-coding-plan"] as const).map(integrationID => subscription({
      integrationID, methods: ["key"], reactive: false,
      select: usage => windows(usage, { defaults: { "5h": 5 * 3600, weekly: 7 * DAY_SECONDS } }) })),
  ]
  return new Map(adapters.map(adapter => [adapter.integrationID, adapter]))
}

/** External/env connections are never automatic candidates. */
export function acceptsMethod(adapter: SelectionAdapter, method: string) {
  return (adapter.methods as readonly string[]).includes(method)
}

export function adapterForProvider(adapters: SelectionAdapters, provider: { id: string; integrationID?: string; canonical?: string }) {
  const adapter = adapters.get(provider.integrationID ?? provider.id)
  if (!adapter?.providers) return adapter
  return adapter.providers.includes(provider.id) || (provider.canonical !== undefined && adapter.providers.includes(provider.canonical))
    ? adapter : undefined
}

function eligible(adapter: Pick<SelectionAdapter, "integrationID" | "methods">, entry: CredentialEntry) {
  const value = entry.value
  if (entry.integrationID !== adapter.integrationID) return false
  if (value.type === "key") return adapter.methods.includes("key") && Boolean(getString(value.key)) && value.key.length <= MAX_SECRET_LENGTH
  return value.type === "oauth" && adapter.methods.includes("oauth")
    && Boolean(getString(value.access)) && value.access.length <= MAX_SECRET_LENGTH
}

function login(entry: CredentialEntry) {
  const email = entry.value.type === "oauth" ? displayLogin(getString(entry.value.metadata?.email)) : undefined
  return email ? { login: email } : {}
}

function digest(parts: unknown[]) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex")
}

/** Selection view of a display reading: every window needs a positive duration. */
function windows(usage: ProviderUsage, options: { drop?: string[]; defaults?: Record<string, number>; fallbackSeconds?: number; dropUnmeasured?: boolean }) {
  const result: Record<string, ProviderUsageWindow> = {}
  for (const [label, window] of Object.entries(usage.windows)) {
    if (options.drop?.includes(label) || (options.dropUnmeasured && window.usedPercent === null)) continue
    result[label] = window.windowSeconds ? window
      : { ...window, windowSeconds: options.defaults?.[label] ?? options.fallbackSeconds ?? null }
  }
  return { windows: result }
}

// Reuses the Usage tab readers with one explicit credential. Fresh Claude
// readers keep no rate-limit fallback snapshot from another account.
async function readUsage(integrationID: string, auth: AuthFile, signal: AbortSignal): Promise<ProviderResult> {
  const reader: UsageProvider | null = integrationID === "anthropic" ? createAnthropicClaudeUsage() : resolveUsageProvider(integrationID)
  if (!reader) throw new Error("Quota unavailable")
  signal.throwIfAborted()
  let abort!: () => void
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error("Quota read aborted"))
    signal.addEventListener("abort", abort, { once: true })
  })
  try { return await Promise.race([reader.fetchQuota(auth), aborted]) }
  finally { signal.removeEventListener("abort", abort) }
}
