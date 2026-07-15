import fs from "fs"
import os from "os"
import path from "path"

import type { UsageProvider } from "../types"
import { asObject, fetchJson, getAuthEntry, getString, notConfigured, result, toNumber, toTimestamp, toUsageWindow } from "../shared"

const GOOGLE_ENDPOINTS = [
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
  "https://autopush-cloudcode-pa.sandbox.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
] as const
const DEFAULT_PROJECT_ID = "rising-fact-p41fc"

interface GoogleSource {
  id: "gemini" | "antigravity"
  accessToken?: string
  refreshToken?: string
  projectId?: string
  expires?: number | null
}

function parseRefresh(value: unknown): { token?: string; projectId?: string } {
  const raw = getString(value)
  if (!raw) return {}
  const [token, projectId, managedProjectId] = raw.split("|")
  return { token: getString(token) ?? undefined, projectId: getString(projectId) ?? getString(managedProjectId) ?? undefined }
}

function readJson(filePath: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"))
  } catch {
    return null
  }
}

function googleSources(): GoogleSource[] {
  const sources: GoogleSource[] = []
  const entry = asObject(getAuthEntry(["google", "google.oauth"]))
  const oauth = asObject(entry?.oauth) ?? entry
  if (oauth) {
    const refresh = parseRefresh(oauth.refresh)
    const accessToken = getString(oauth.access) ?? getString(oauth.token) ?? undefined
    if (accessToken || refresh.token) {
      sources.push({
        id: "gemini",
        accessToken,
        refreshToken: refresh.token,
        projectId: refresh.projectId,
        expires: toTimestamp(oauth.expires),
      })
    }
  }

  const home = os.homedir()
  for (const candidate of [
    path.join(home, ".config", "opencode", "antigravity-accounts.json"),
    path.join(home, ".local", "share", "opencode", "antigravity-accounts.json"),
  ]) {
    const data = readJson(candidate)
    const accounts = Array.isArray(data?.accounts) ? data.accounts : []
    const account = accounts[data?.activeIndex ?? 0] ?? accounts[0]
    const refresh = parseRefresh(account?.refreshToken)
    const accessToken = getString(account?.accessToken) ?? getString(account?.access_token) ?? undefined
    if (accessToken || refresh.token) {
      sources.push({
        id: "antigravity",
        accessToken,
        refreshToken: refresh.token,
        projectId: getString(account?.projectId) ?? refresh.projectId,
        expires: toTimestamp(account?.expiresAt ?? account?.expires),
      })
      break
    }
  }
  return sources
}

async function refreshAccessToken(source: GoogleSource): Promise<string | null> {
  if (!source.refreshToken) return null
  const prefix = source.id === "gemini" ? "GOOGLE" : "ANTIGRAVITY"
  const clientId = getString(process.env[`${prefix}_OAUTH_CLIENT_ID`])
  const clientSecret = getString(process.env[`${prefix}_OAUTH_CLIENT_SECRET`])
  if (!clientId || !clientSecret) return null
  const payload = await fetchJson("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: source.refreshToken,
      grant_type: "refresh_token",
    }),
  })
  return getString(payload?.access_token)
}

function transformModel(sourceId: string, modelId: string, data: any) {
  const fraction = toNumber(data?.quotaInfo?.remainingFraction ?? data?.remainingFraction)
  const resetAt = toTimestamp(data?.quotaInfo?.resetTime ?? data?.resetTime)
  const label = sourceId === "gemini" || (resetAt !== null && resetAt - Date.now() > 10 * 3600 * 1000) ? "daily" : "5h"
  return {
    [`${sourceId}/${modelId}`]: {
      windows: {
        [label]: toUsageWindow({
          usedPercent: fraction === null ? null : 100 - fraction * 100,
          windowSeconds: label === "daily" ? 86_400 : 5 * 3600,
          resetAt,
        }),
      },
    },
  }
}

const google: UsageProvider = {
  id: "google",
  name: "Google",
  aliases: ["google", "google.oauth", "gemini", "antigravity"],
  async fetchQuota() {
    const sources = googleSources()
    if (sources.length === 0) return notConfigured(this.id, this.name)
    const models: Record<string, { windows: Record<string, ReturnType<typeof toUsageWindow>> }> = {}
    try {
      for (const source of sources) {
        const accessToken = source.accessToken && (!source.expires || source.expires > Date.now())
          ? source.accessToken
          : await refreshAccessToken(source)
        if (!accessToken) continue
        const projectId = source.projectId ?? DEFAULT_PROJECT_ID
        if (source.id === "gemini") {
          try {
            const quota = await fetchJson(`${GOOGLE_ENDPOINTS[2]}/v1internal:retrieveUserQuota`, {
              method: "POST",
              headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
              body: JSON.stringify({ project: projectId }),
            })
            for (const bucket of Array.isArray(quota?.buckets) ? quota.buckets : []) {
              const modelId = getString(bucket?.modelId)
              if (modelId) Object.assign(models, transformModel(source.id, modelId, bucket))
            }
          } catch {
            // The model endpoint below often remains available when quota buckets are not.
          }
        }
        for (const endpoint of GOOGLE_ENDPOINTS) {
          try {
            const payload = await fetchJson(`${endpoint}/v1internal:fetchAvailableModels`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
                "User-Agent": "antigravity/1.11.5 windows/amd64",
                "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
              },
              body: JSON.stringify({ project: projectId }),
            })
            for (const [modelId, data] of Object.entries(payload?.models ?? {})) {
              Object.assign(models, transformModel(source.id, modelId, data))
            }
            break
          } catch {
            continue
          }
        }
      }
      if (Object.keys(models).length === 0) throw new Error("No model quota data available")
      return result(this.id, this.name, { ok: true, configured: true, usage: { windows: {}, models } })
    } catch (error) {
      return result(this.id, this.name, {
        ok: false,
        configured: true,
        error: error instanceof Error ? error.message : "Request failed",
      })
    }
  },
}

export const googleProviders: UsageProvider[] = [google]
