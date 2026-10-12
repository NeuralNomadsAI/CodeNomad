import type { ServiceConnection } from "../workspaces/opencode-service"
import type { SettingsService } from "../settings/service"
import { fetchCodexSelectionQuota } from "../usage/native-codex"
import { ProviderHttpError } from "../usage/shared"
import type { ProviderUsage } from "../usage/types"
import type { ProviderAccountsSnapshot } from "../api-types"
import { readLocationRef } from "../opencode/compatibility/location"
import { acceptsMethod, adapterForProvider, createSelectionAdapters, type SelectionAdapters, type SelectionCredential } from "./adapters"
import { QuotaMarks, type QuotaFailure } from "./quota-marks"

export class AccountSelectionFailed extends Error {
  constructor() { super("Provider account selection failed") }
}

type ConnectionState = { epoch: number; manual: number; pending?: Promise<void>; marks: QuotaMarks }
type ReadState = "unknown" | "available" | "exhausted" | "rejected"

export class ProviderAccountsService {
  private policyRevision = 0
  private readonly states = new WeakMap<ServiceConnection, ConnectionState>()
  constructor(private readonly settings: Pick<SettingsService, "getOwner" | "mergePatchOwner">,
    quota = fetchCodexSelectionQuota,
    private readonly adapters: SelectionAdapters = createSelectionAdapters({ codexQuota: quota })) {}

  private state(connection: ServiceConnection) {
    let state = this.states.get(connection)
    if (!state) { state = { epoch: 0, manual: 0, marks: new QuotaMarks() }; this.states.set(connection, state) }
    return state
  }

  // Fence local explicit mutations immediately, including switches away and back.
  // A manual account change also forgets reactive exhaustion marks.
  manual(connection: ServiceConnection) {
    const state = this.state(connection)
    state.epoch++; state.manual++
    state.marks.manualChange()
    let released = false
    return () => { if (!released) { released = true; state.manual--; state.epoch++ } }
  }

  supports(integrationID: string) { return this.adapters.has(integrationID) }

  private policy(): Record<string, unknown> {
    const policy = this.settings.getOwner("config", "providerAccounts")?.autoSelect
    return policy && typeof policy === "object" && !Array.isArray(policy) ? policy as Record<string, unknown> : {}
  }
  enabled(integrationID = "openai") {
    const policy = this.policy()
    return this.supports(integrationID) && Object.prototype.hasOwnProperty.call(policy, integrationID) && policy[integrationID] === true
  }
  private anyEnabled() { return [...this.adapters.keys()].some(id => this.enabled(id)) }
  setEnabled(enabled: boolean, integrationID = "openai") {
    if (!this.supports(integrationID)) throw new Error("Unsupported integration")
    this.settings.mergePatchOwner("config", "providerAccounts", { autoSelect: { [integrationID]: enabled } })
    this.policyRevision++
  }

  async snapshot(connection: ServiceConnection, directory: string, integrationID: string, signal: AbortSignal): Promise<ProviderAccountsSnapshot> {
    const adapter = this.adapters.get(integrationID)
    if (!adapter) return { supported: false, enabled: false, logins: {} }
    const integration = await this.integration(connection, directory, integrationID, signal)
    const entries = await connection.client.credential.list({ signal })
    const logins: Record<string, string> = {}
    let eligible = 0
    for (const item of integration.connections.slice(0, 128)) {
      if (item.type !== "credential" || !acceptsMethod(adapter, item.method)) continue
      const entry = entries.find(entry => entry.id === item.id && entry.integrationID === integrationID)
      const credential = entry && adapter.credential(entry)
      if (!credential) continue
      eligible++
      // Preserve all explicit aliases; only native's fallback label is enriched.
      if (item.label === "default" && credential.login) logins[item.id] = credential.login
    }
    connection.assertCurrent(); signal.throwIfAborted()
    return { supported: eligible >= 2, enabled: this.enabled(integrationID), logins }
  }

  async beforeSend(connection: ServiceConnection, sessionID: string, signal: AbortSignal, validate: (directory: string) => Promise<boolean>) {
    if (!this.anyEnabled()) return
    const state = this.state(connection)
    // Serialize decisions across this backend's workspaces, without retaining exports.
    const previous = state.pending
    const task = (async () => {
      await previous?.catch(() => {})
      signal.throwIfAborted(); connection.assertCurrent()
      if (!this.anyEnabled() || state.manual) return
      const epoch = state.epoch
      const policyRevision = this.policyRevision
      const session = await connection.client.session.get({ sessionID }, { signal })
      if (!session.model || readLocationRef(session.location).workspaceID !== undefined) return
      const directory = session.location.directory
      if (!await validate(directory)) return
      const provider = await connection.client.provider.get({ providerID: session.model.providerID, location: { directory } }, { signal })
      if (provider.location.directory !== directory || provider.data.id !== session.model.providerID) return
      const adapter = adapterForProvider(this.adapters, provider.data)
      if (!adapter || !this.enabled(adapter.integrationID)) return
      const integrationID = adapter.integrationID
      const integration = await this.integration(connection, directory, integrationID, signal)
      const selected = integration.connections[0]
      if (selected?.type !== "credential" || !acceptsMethod(adapter, selected.method) || selected.status?.status === "needs_auth") return
      const entries = await connection.client.credential.list({ signal })
      const currentEntry = entries.find(entry => entry.integrationID === integrationID && entry.id === selected.id && entry.active)
      const current = currentEntry && adapter.credential(currentEntry)
      if (!current) return
      const currentRead = await this.read(current, connection, signal)
      if (currentRead === "available") { state.marks.clear(integrationID, selected.id); return }
      // A native quota failure fills in only when the quota read is not "available".
      if (currentRead !== "exhausted" && !state.marks.has(integrationID, selected.id)) return
      // Stable native catalog order; never temporarily activate candidates to query them.
      for (const candidate of integration.connections.slice(1, 21)) {
        if (candidate.type !== "credential" || !acceptsMethod(adapter, candidate.method) || candidate.status?.status === "needs_auth") continue
        const entry = entries.find(entry => entry.integrationID === integrationID && entry.id === candidate.id)
        const credential = entry && adapter.credential(entry)
        if (!credential) continue
        const marked = state.marks.has(integrationID, candidate.id)
        const read = await this.read(credential, connection, signal)
        if (read === "available") state.marks.clear(integrationID, candidate.id)
        if (!(read === "available" || (adapter.reactive && read === "unknown" && !marked))) continue
        if (epoch !== state.epoch || state.manual || policyRevision !== this.policyRevision || !this.enabled(integrationID) || !await validate(directory)) return
        const latest = await this.integration(connection, directory, integrationID, signal)
        const fresh = await connection.client.credential.list({ signal })
        const freshCurrent = fresh.find(entry => entry.id === selected.id && entry.active && entry.integrationID === integrationID)
        const freshCandidate = fresh.find(entry => entry.id === candidate.id && entry.integrationID === integrationID)
        const candidateConnection = latest.connections.find(item => item.type === "credential" && item.id === candidate.id)
        const currentConnection = latest.connections[0]
        if (currentConnection?.type !== "credential" || currentConnection.id !== selected.id
          || !candidateConnection || candidateConnection.status?.status === "needs_auth"
          || !freshCurrent || adapter.credential(freshCurrent)?.identity !== current.identity
          || !freshCandidate || adapter.credential(freshCandidate)?.identity !== credential.identity) return
        const latestSession = await connection.client.session.get({ sessionID }, { signal })
        if (latestSession.location.directory !== directory || latestSession.model?.providerID !== session.model.providerID
          || latestSession.model?.id !== session.model.id || !await validate(directory)) return
        connection.assertCurrent(); signal.throwIfAborted()
        if (epoch !== state.epoch || state.manual || policyRevision !== this.policyRevision || !this.enabled(integrationID)) return
        state.marks.switched(integrationID)
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

  /** Bookkeeping from the native event stream; synchronous and bounded. */
  observeSwitch(connection: ServiceConnection, integrationID: string, at: number) {
    this.state(connection).marks.switched(integrationID, at)
  }
  observeStepStart(connection: ServiceConnection, sessionID: string, at: number, providerID?: string) {
    this.state(connection).marks.stepStarted(sessionID, at, providerID)
  }

  /**
   * Marks the account that served a native `provider.quota` failure. Only an
   * unambiguous attribution marks: a credential switch since the failing step
   * started, a manual change, a disabled policy or an unregistered provider skip it.
   */
  async markQuotaFailure(connection: ServiceConnection, failure: QuotaFailure, signal: AbortSignal) {
    const state = this.state(connection)
    const step = state.marks.stepFor(failure.sessionID, failure.failedAt)
    const epoch = state.epoch
    connection.assertCurrent(); signal.throwIfAborted()
    const session = await connection.client.session.get({ sessionID: failure.sessionID }, { signal })
    const providerID = step.providerID ?? session.model?.providerID
    if (!providerID || readLocationRef(session.location).workspaceID !== undefined) return false
    const directory = session.location.directory
    const provider = await connection.client.provider.get({ providerID, location: { directory } }, { signal })
    if (provider.location.directory !== directory || provider.data.id !== providerID) return false
    const adapter = adapterForProvider(this.adapters, provider.data)
    if (!adapter || !this.enabled(adapter.integrationID)) return false
    const integrationID = adapter.integrationID
    const integration = await this.integration(connection, directory, integrationID, signal)
    const selected = integration.connections[0]
    if (selected?.type !== "credential" || !acceptsMethod(adapter, selected.method)) return false
    const entries = await connection.client.credential.list({ signal })
    const entry = entries.find(entry => entry.integrationID === integrationID && entry.id === selected.id && entry.active)
    if (!entry || !adapter.credential(entry)) return false
    connection.assertCurrent(); signal.throwIfAborted()
    if (epoch !== state.epoch || state.manual || state.marks.switchedSince(integrationID, step.startedAt)) return false
    state.marks.mark(integrationID, selected.id, failure.limitName)
    return true
  }

  private async read(credential: SelectionCredential, connection: ServiceConnection, signal: AbortSignal): Promise<ReadState> {
    try { return quotaState(await credential.read(signal)) }
    catch (error) {
      signal.throwIfAborted(); connection.assertCurrent()
      // Unauthorized or unentitled (e.g. no Go subscription) is never a candidate.
      return error instanceof ProviderHttpError && (error.status === 401 || error.status === 403) ? "rejected" : "unknown"
    }
  }

  private async integration(connection: ServiceConnection, directory: string, integrationID: string, signal: AbortSignal) {
    connection.assertCurrent(); signal.throwIfAborted()
    const result = await connection.client.integration.get({ integrationID, location: { directory } }, { signal })
    if (result.location.directory !== directory || result.data.id !== integrationID) throw new Error("Account catalog changed")
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
