import type { ServiceConnection } from "../workspaces/opencode-service"
import type { SettingsService } from "../settings/service"
import { codexCredential } from "../usage/codex-credential"
import { fetchCodexSelectionQuota } from "../usage/native-codex"
import type { ProviderUsage } from "../usage/types"
import type { ProviderAccountsSnapshot } from "../api-types"
import { readLocationRef } from "../opencode/compatibility/location"

export class AccountSelectionFailed extends Error {
  constructor() { super("Provider account selection failed") }
}

export class ProviderAccountsService {
  private policyRevision = 0
  private readonly states = new WeakMap<ServiceConnection, { epoch: number; manual: number; pending?: Promise<void> }>()
  constructor(private readonly settings: Pick<SettingsService, "getOwner" | "mergePatchOwner">,
    private readonly quota = fetchCodexSelectionQuota) {}

  private state(connection: ServiceConnection) {
    let state = this.states.get(connection)
    if (!state) { state = { epoch: 0, manual: 0 }; this.states.set(connection, state) }
    return state
  }

  // Fence local explicit mutations immediately, including switches away and back.
  manual(connection: ServiceConnection) {
    const state = this.state(connection)
    state.epoch++; state.manual++
    let released = false
    return () => { if (!released) { released = true; state.manual--; state.epoch++ } }
  }

  enabled() {
    const policy = this.settings.getOwner("config", "providerAccounts")?.autoSelect
    return Boolean(policy && typeof policy === "object" && "openai" in policy && policy.openai === true)
  }
  setEnabled(enabled: boolean) {
    this.settings.mergePatchOwner("config", "providerAccounts", { autoSelect: { openai: enabled } })
    this.policyRevision++
  }

  async snapshot(connection: ServiceConnection, directory: string, integrationID: string, signal: AbortSignal): Promise<ProviderAccountsSnapshot> {
    if (integrationID !== "openai") return { supported: false, enabled: false, logins: {} }
    const integration = await this.integration(connection, directory, signal)
    const entries = await connection.client.credential.list({ signal })
    const logins: Record<string, string> = {}
    let eligible = 0
    for (const item of integration.connections.slice(0, 128)) {
      if (item.type !== "credential" || item.method !== "oauth") continue
      const entry = entries.find(entry => entry.id === item.id && entry.integrationID === "openai")
      const credential = entry && codexCredential(entry)
      if (!credential) continue
      eligible++
      // Preserve all explicit aliases; only native's fallback label is enriched.
      if (item.label === "default" && credential.login) logins[item.id] = credential.login
    }
    connection.assertCurrent(); signal.throwIfAborted()
    return { supported: eligible >= 2, enabled: this.enabled(), logins }
  }

  async beforeSend(connection: ServiceConnection, sessionID: string, signal: AbortSignal, validate: (directory: string) => Promise<boolean>) {
    if (!this.enabled()) return
    const state = this.state(connection)
    // Serialize decisions across this backend's workspaces, without retaining exports.
    const previous = state.pending
    const task = (async () => {
      await previous?.catch(() => {})
      signal.throwIfAborted(); connection.assertCurrent()
      if (!this.enabled() || state.manual) return
      const epoch = state.epoch
      const policyRevision = this.policyRevision
      const session = await connection.client.session.get({ sessionID }, { signal })
      if (!session.model || readLocationRef(session.location).workspaceID !== undefined) return
      const directory = session.location.directory
      if (!await validate(directory)) return
      const provider = await connection.client.provider.get({ providerID: session.model.providerID, location: { directory } }, { signal })
      if (provider.location.directory !== directory || provider.data.id !== session.model.providerID
        || provider.data.integrationID !== "openai") return
      const integration = await this.integration(connection, directory, signal)
      const selected = integration.connections[0]
      if (selected?.type !== "credential" || selected.method !== "oauth" || selected.status?.status === "needs_auth") return
      const entries = await connection.client.credential.list({ signal })
      const currentEntry = entries.find(entry => entry.integrationID === "openai" && entry.id === selected.id && entry.active)
      const current = currentEntry && codexCredential(currentEntry)
      if (!current || quotaState(await this.quota(current.access, current.accountID, signal)) !== "exhausted") return
      // Stable native catalog order; never temporarily activate candidates to query them.
      for (const candidate of integration.connections.slice(1, 21)) {
        if (candidate.type !== "credential" || candidate.method !== "oauth" || candidate.status?.status === "needs_auth") continue
        const entry = entries.find(entry => entry.integrationID === "openai" && entry.id === candidate.id)
        const credential = entry && codexCredential(entry)
        if (!credential) continue
        let available = false
        try { available = quotaState(await this.quota(credential.access, credential.accountID, signal)) === "available" }
        catch { signal.throwIfAborted(); connection.assertCurrent() }
        if (!available) continue
        if (epoch !== state.epoch || state.manual || policyRevision !== this.policyRevision || !this.enabled() || !await validate(directory)) return
        const latest = await this.integration(connection, directory, signal)
        const fresh = await connection.client.credential.list({ signal })
        const freshCurrent = fresh.find(entry => entry.id === selected.id && entry.active && entry.integrationID === "openai")
        const freshCandidate = fresh.find(entry => entry.id === candidate.id && entry.integrationID === "openai")
        const candidateConnection = latest.connections.find(item => item.type === "credential" && item.id === candidate.id)
        const currentConnection = latest.connections[0]
        if (currentConnection?.type !== "credential" || currentConnection.id !== selected.id
          || !candidateConnection || candidateConnection.status?.status === "needs_auth"
          || !freshCurrent || codexCredential(freshCurrent)?.identity !== current.identity
          || !freshCandidate || codexCredential(freshCandidate)?.identity !== credential.identity) return
        const latestSession = await connection.client.session.get({ sessionID }, { signal })
        if (latestSession.location.directory !== directory || latestSession.model?.providerID !== session.model.providerID
          || latestSession.model?.id !== session.model.id || !await validate(directory)) return
        connection.assertCurrent(); signal.throwIfAborted()
        if (epoch !== state.epoch || state.manual || policyRevision !== this.policyRevision || !this.enabled()) return
        try { await connection.client.credential.activate({ credentialID: candidate.id }, { signal }) }
        catch { throw new AccountSelectionFailed() }
        return // One attempt only, including ambiguous transport failures. No replay.
      }
    })()
    state.pending = task
    try { await task }
    catch (error) {
      if (error instanceof AccountSelectionFailed) throw error
      // Unknown usage leaves the native selection alone. Connection invalidation
      // and caller cancellation still abort the send; never expose SDK errors.
      connection.assertCurrent()
    } finally { if (state.pending === task) state.pending = undefined }
  }

  private async integration(connection: ServiceConnection, directory: string, signal: AbortSignal) {
    connection.assertCurrent(); signal.throwIfAborted()
    const result = await connection.client.integration.get({ integrationID: "openai", location: { directory } }, { signal })
    if (result.location.directory !== directory || result.data.id !== "openai") throw new Error("Account catalog changed")
    connection.assertCurrent(); signal.throwIfAborted()
    return result.data
  }
}

// Past reset snapshots and empty/non-numeric usage are not availability evidence.
export function quotaState(usage: ProviderUsage, now = Date.now()): "unknown" | "available" | "exhausted" {
  const windows = Object.values(usage.windows).filter(window => window.windowSeconds !== null && window.windowSeconds > 0)
  if (!windows.length || windows.some(window => window.usedPercent === null || !Number.isFinite(window.usedPercent)
    || (window.resetAt !== null && window.resetAt <= now))) return "unknown"
  return windows.some(window => window.usedPercent! >= 100) ? "exhausted" : "available"
}
