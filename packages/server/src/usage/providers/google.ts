import type { ProviderUsageWindow } from "../../api-types"
import { fetchBoundedJson } from "../bounded-fetch"
import { createGoogleTokenReader, googleCredential, googleQuotaIdentityGuard } from "../google-credential"
import { asObject, getString, notConfigured, result, toTimestamp, toUsageWindow } from "../shared"
import type { AuthFile, ProviderResult, ProviderUsage, UsageProvider } from "../types"
import { antigravityQuota } from "./antigravity"

const readToken = createGoogleTokenReader()
// Bound standalone reads too; the route supplies its earlier entry-time deadline.
const QUOTA_TIMEOUT_MS = 12_000

export function unknownGoogleUsage(auth: AuthFile): ProviderResult {
  return result("google", asObject(auth.google)?.methodID === "antigravity" ? "Antigravity" : "Gemini CLI",
    { configured: Boolean(asObject(auth.google)), ok: false })
}

// Code Assist quota schema:
// https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/code_assist/types.ts

// Strip transport prefixes only; flash, flash-lite, pro and preview variants stay distinct.
function modelName(value: string): string | null {
  const name = value.replace(/^(?:google\/)?(?:models\/|gemini-cli[/-])?/, "")
  return name.length <= 64 && /^gemini-\d{1,2}(?:\.\d{1,2})?-(?:pro|flash(?:-lite)?)(?:-(?:preview|exp))?(?:-\d{2}-\d{2}|-\d{3})?$/.test(name) ? name : null
}

/** Exact Google model selection, independent of the shared readers' fuzzy matching. */
export function selectGoogleModelWindows(reading: ProviderResult, modelId?: string): Record<string, ProviderUsageWindow> {
  const models = reading.usage?.models ?? {}
  const selected = modelId ? models[modelName(modelId) ?? ""] : undefined
  const entries = modelId ? (selected ? [[modelName(modelId)!, selected] as const] : []) : Object.entries(models)
  return { ...reading.usage?.windows,
    ...Object.fromEntries(entries.flatMap(([model, usage]) => Object.entries(usage.windows).map(([key, value]) => [`${key}:${model}`, value]))) }
}

export const googleUsage: UsageProvider = {
  id: "google", name: "Gemini CLI", aliases: ["google"],
  async fetchQuota(auth, context) {
    const entry = asObject(auth.google)
    if (!entry) return notConfigured("google", "Gemini CLI")
    const name = entry.methodID === "antigravity" ? "Antigravity" : "Gemini CLI"
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), QUOTA_TIMEOUT_MS)
    const signal = context?.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal
    try {
      const credential = googleCredential(auth)
      if (!credential) throw new Error("Google usage unavailable")
      if (credential.methodID === "antigravity" && !credential.project) throw new Error("Google usage unavailable")
      const access = await readToken(credential, signal)
      const safeIdentity = googleQuotaIdentityGuard(auth, access)
      if (credential.methodID === "antigravity") {
        return result("google", name, { configured: true, ok: true,
          usage: await antigravityQuota(access, credential.project!, signal, safeIdentity) })
      }
      const headers = { Authorization: `Bearer ${access}`, "Content-Type": "application/json" }
      let project = credential.project
      if (!project) {
        // Read existing setup only; quota display never onboards an account.
        const setup = asObject(await fetchBoundedJson("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", headers,
          signal, undefined, { method: "POST", body: JSON.stringify({ metadata: {
            ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" } }) }))
        project = getString(setup?.cloudaicompanionProject)
      }
      if (!project) throw new Error("Google usage unavailable")
      const payload = asObject(await fetchBoundedJson("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota", headers,
        signal, undefined, { method: "POST", body: JSON.stringify({ project }) }))
      if (!Array.isArray(payload?.buckets)) throw new Error("Google usage unavailable")
      const models: NonNullable<ProviderUsage["models"]> = {}
      for (const raw of payload.buckets) {
        const bucket = asObject(raw)
        const model = typeof bucket?.modelId === "string" ? modelName(bucket.modelId) : null
        if (!model || [bucket?.modelId, bucket?.bucketId, bucket?.displayName, bucket?.tokenType]
          .some(value => typeof value === "string" && !safeIdentity(value)) || !safeIdentity(model)) continue
        const fraction = bucket?.remainingFraction
        const valid = typeof fraction === "number" && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1
        const type = getString(bucket?.tokenType)
        const key = type && /^(?:REQUESTS|TOKENS|INPUT_TOKENS|OUTPUT_TOKENS)$/.test(type) ? type.toLowerCase() : "usage"
        if (!safeIdentity(`${key}:${model}`)) continue
        const windows = (models[model] ??= { windows: {} }).windows
        // Ambiguous duplicate buckets are unavailable, never summed or overwritten.
        if (windows[key]) throw new Error("Google usage unavailable")
        windows[key] = toUsageWindow({ usedPercent: valid ? (1 - fraction) * 100 : null, resetAt: toTimestamp(bucket?.resetTime) })
      }
      if (!Object.values(models).some(model => Object.values(model.windows).some(window => window.usedPercent !== null))) {
        throw new Error("Google usage unavailable")
      }
      return result("google", "Gemini CLI", { configured: true, ok: true, usage: { windows: {}, models } })
    } catch {
      // Refresh/quota failures are unknown usage, never connection errors or upstream prose.
      return unknownGoogleUsage(auth)
    } finally {
      clearTimeout(timeout)
    }
  },
}
