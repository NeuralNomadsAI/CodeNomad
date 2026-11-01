import { readFile } from "node:fs/promises"
import type { PluginControlLocation } from "../../api-types"
import type { IntegrationAttachmentHint, IntegrationAttachRequest, IntegrationBindingResponse, IntegrationDetachRequest, IntegrationHostsResponse } from "../../integration-types"
import { INTEGRATION_ATTACHMENT_METADATA_KEY } from "../../integration-types"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { ServiceConnection } from "../../workspaces/opencode-service"
import { locationRequestOptions, readLocationRef, sameLocation } from "../compatibility/location"
import { PluginControlsError, type PluginControls } from "../plugin-controls"
import type { IntegrationCatalogSource } from "./catalog"
import { integrationRpcSchemas, readIntegrationRpcOutput, type IntegrationCatalogEntry, type IntegrationRpcValue } from "./contract"
import { recognizeIntegrations } from "./recognition"
import { looksLikePath } from "./status"
import { NativeMutationAdmission, type NativeMutationAuthority } from "../native-mutation-authority"

export const INTEGRATION_ATTACHMENT_TIMEOUT_MS = 8_000
const INTEGRATION_HOST_DETECTION_TIMEOUT_MS = 1_000
export type IntegrationAttachmentErrorCode = "invalid" | "not-found" | "forbidden" | "inactive" | "unsupported" | "non-conforming" | "unavailable"

/** Only fixed, content-free failures cross the HTTP boundary, including native session failures. */
export class IntegrationAttachmentError extends Error {
  constructor(readonly code: IntegrationAttachmentErrorCode) { super(`Integration attachment ${code}`) }
}

export interface IntegrationAttachmentsDeps {
  controls: Pick<PluginControls, "read">
  workspaceManager: Pick<WorkspaceManager, "getSharedServiceConnection" | "ownsLocation"> & Partial<Pick<WorkspaceManager, "getServiceWslDistro">>
  catalog: Pick<IntegrationCatalogSource, "read">
  now?: () => number
  timeoutMs?: number
  hostPlatform?: NodeJS.Platform
  hostEnv?: NodeJS.ProcessEnv
  readKernelVersion?: () => Promise<string>
}

type Context = { workspaceId: string; location: PluginControlLocation; entry: IntegrationCatalogEntry; connection: ServiceConnection; signal: AbortSignal; admission: NativeMutationAdmission; hostsRead: boolean }
type Method = "status" | "hosts" | "attachHost" | "detachHost" | "installHost" | "bindingRead"

/** Fixed catalog RPCs for an owned Location; Q8 stores a reattach hint, with live state owned by the plugin. */
export class IntegrationAttachments {
  private readonly sessions = new Map<string, Promise<unknown>>()
  constructor(private readonly deps: IntegrationAttachmentsDeps) {}

  async assertHostInstallationSupported(workspaceId: string): Promise<void> {
    // Refuse before catalog.read(), which can persist a refresh. A mirrored offer never authorizes installation.
    if (this.deps.workspaceManager.getServiceWslDistro?.(workspaceId)) throw new IntegrationAttachmentError("unsupported")
    if ((this.deps.hostPlatform ?? process.platform) === "linux") {
      if ((this.deps.hostEnv ?? process.env).WSL_DISTRO_NAME !== undefined) throw new IntegrationAttachmentError("unsupported")
      let version: string
      try { version = await (this.deps.readKernelVersion ?? (() => readFile("/proc/version", { encoding: "utf8", signal: AbortSignal.timeout(INTEGRATION_HOST_DETECTION_TIMEOUT_MS) })))() }
      catch { throw new IntegrationAttachmentError("unavailable") }
      if (/microsoft/i.test(version)) throw new IntegrationAttachmentError("unsupported")
    }
  }

  async installHost(workspaceId: string, integrationId: string, location: PluginControlLocation, signal?: AbortSignal, authority?: NativeMutationAuthority) {
    await this.assertHostInstallationSupported(workspaceId)
    return this.run(workspaceId, integrationId, location, signal, async context => {
      await this.status(context)
      const result = await this.call(context, "installHost", { target: "default" })
      if (result.detail !== undefined && looksLikePath(result.detail)) throw new IntegrationAttachmentError("non-conforming")
      return { outcome: result.outcome }
    }, true, authority)
  }

  hosts(workspaceId: string, integrationId: string, location: PluginControlLocation, signal?: AbortSignal, authority?: NativeMutationAuthority): Promise<IntegrationHostsResponse> {
    return this.run(workspaceId, integrationId, location, signal, async context => {
      await this.status(context)
      return this.call(context, "hosts", {})
    }, Boolean(authority), authority, true)
  }

  async bindingRead(workspaceId: string, integrationId: string, location: PluginControlLocation, input: IntegrationRpcValue<"bindingRead.input">, signal?: AbortSignal): Promise<IntegrationBindingResponse> {
    if (!integrationRpcSchemas["bindingRead.input"].safeParse(input).success || !input.sessionID.startsWith("ses")) throw new IntegrationAttachmentError("invalid")
    try {
      return await this.run(workspaceId, integrationId, location, signal, async context => {
        const result = await this.call(context, "bindingRead", input, input.sessionID)
        if (result.state !== "attached") return { state: result.state }
        if (looksLikePath(result.binding.label)) throw new IntegrationAttachmentError("non-conforming")
        return { state: "attached", label: result.binding.label }
      })
    } catch (error) {
      if (error instanceof IntegrationAttachmentError && (error.code === "invalid" || error.code === "forbidden")) throw error
      return { state: "unknown" }
    }
  }

  attach(workspaceId: string, integrationId: string, location: PluginControlLocation, input: IntegrationAttachRequest, signal?: AbortSignal, authority?: NativeMutationAuthority) {
    if (!integrationRpcSchemas["attachHost.input"].safeParse(input).success || !input.sessionID.startsWith("ses")) return Promise.reject(new IntegrationAttachmentError("invalid"))
    return this.run(workspaceId, integrationId, location, signal, context => this.serialize(input.sessionID, context.signal, async () => {
      await this.status(context, input.sessionID)
      const hosts = await this.call(context, "hosts", {}, input.sessionID)
      const offer = hosts.offers.find(candidate => candidate.offerID === input.offerID)
      if (!offer) return { outcome: "gone" as const }
      if (offer.protocol !== "ok") return { outcome: "refused" as const }
      const result = await this.call(context, "attachHost", input, input.sessionID)
      if (result.outcome === "attached") {
        await this.writeHint(context, input.sessionID, {
          integration: context.entry.id, label: offer.label, attachedAt: (this.deps.now ?? Date.now)(),
        })
      }
      return result
    }), Boolean(authority), authority)
  }

  detach(workspaceId: string, integrationId: string, location: PluginControlLocation, input: IntegrationDetachRequest, signal?: AbortSignal, authority?: NativeMutationAuthority) {
    // Native Session.ID requires the `ses` prefix. Refuse malformed IDs before native URL logging.
    if (!integrationRpcSchemas["detachHost.input"].safeParse(input).success || !input.sessionID.startsWith("ses")) return Promise.reject(new IntegrationAttachmentError("invalid"))
    return this.run(workspaceId, integrationId, location, signal, context => this.serialize(input.sessionID, context.signal, async () => {
      // Detach remains available when the application is gone or unsupported.
      const result = await this.call(context, "detachHost", input, input.sessionID)
      await this.writeHint(context, input.sessionID)
      return result
    }), Boolean(authority), authority)
  }

  private serialize<T>(sessionID: string, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const pending = (this.sessions.get(sessionID) ?? Promise.resolve()).catch(() => undefined).then(operation)
    const result = new Promise<T>((resolve, reject) => {
      const abort = () => reject(new IntegrationAttachmentError("unavailable"))
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
      pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
    })
    this.sessions.set(sessionID, result)
    void result.finally(() => { if (this.sessions.get(sessionID) === result) this.sessions.delete(sessionID) }).catch(() => undefined)
    return result
  }

  private async run<T>(workspaceId: string, integrationId: string, location: PluginControlLocation, outer: AbortSignal | undefined,
    operation: (context: Context) => Promise<T>, readOnlyCatalog = false, authority?: NativeMutationAuthority, hostsRead = false): Promise<T> {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(integrationId) || location.workspaceID !== undefined
      || !location.directory || location.directory.length > 32_768 || /\p{Cc}/u.test(location.directory)) throw new IntegrationAttachmentError("invalid")
    const timeout = AbortSignal.timeout(this.deps.timeoutMs ?? INTEGRATION_ATTACHMENT_TIMEOUT_MS)
    const signal = outer ? AbortSignal.any([outer, timeout]) : timeout
    const admission = new NativeMutationAdmission(authority)
    // Bound even an adapter ignoring cancellation; every later dispatch checks this same signal.
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(admission.failure(new IntegrationAttachmentError("unavailable")))
      if (signal.aborted) return abort()
      signal.addEventListener("abort", abort, { once: true })
      const work = async () => {
        await admission.revalidate()
        signal.throwIfAborted()
        const connection = await this.deps.workspaceManager.getSharedServiceConnection(workspaceId)
        if (!connection) throw new IntegrationAttachmentError("unavailable")
        if (hostsRead) admission.assertCurrent()
        else await admission.revalidate()
        signal.throwIfAborted()
        const [snapshot, catalog] = await Promise.all([this.deps.controls.read(workspaceId, location, signal), this.deps.catalog.read(readOnlyCatalog ? { refresh: false } : undefined)])
        const recognition = recognizeIntegrations(catalog.catalog, snapshot).find(item => item.entry.id === integrationId)
        if (!recognition) throw new IntegrationAttachmentError("not-found")
        if (recognition.entry.family !== "native") throw new IntegrationAttachmentError("unsupported")
        if (recognition.ambiguous) throw new IntegrationAttachmentError("non-conforming")
        if (recognition.runtime?.state.status !== "active") throw new IntegrationAttachmentError("inactive")
        const context: Context = { workspaceId, location: snapshot.location, entry: recognition.entry, connection, signal, admission, hostsRead }
        await this.authorize(context)
        const result = await operation(context)
        await admission.revalidate()
        return result
      }
      work().then(resolve, error => reject(admission.failure(error instanceof IntegrationAttachmentError ? error
        : new IntegrationAttachmentError(error instanceof PluginControlsError
          && (error.kind === "forbidden" || error.kind === "not-found" || error.kind === "invalid") ? error.kind : "unavailable"))))
        .finally(() => signal.removeEventListener("abort", abort))
    })
  }

  private async authorize(context: Context) {
    // Read-only offer inspection refreshes full authority at entry/return. Mutation
    // prerequisites retain every full checkpoint, including the Q8 continuation.
    if (context.hostsRead) context.admission.assertCurrent()
    else await context.admission.revalidate()
    context.signal.throwIfAborted()
    context.connection.assertCurrent()
    if (context.location.workspaceID !== undefined || !await this.deps.workspaceManager.ownsLocation(
      context.workspaceId, context.location, context.connection.client, context.signal,
    )) throw new IntegrationAttachmentError("forbidden")
    if (context.hostsRead) context.admission.assertCurrent()
    else await context.admission.revalidate()
    context.signal.throwIfAborted()
    context.connection.assertCurrent()
  }

  private async session(context: Context, sessionID: string) {
    await this.authorize(context)
    context.signal.throwIfAborted()
    context.connection.assertCurrent()
    const session = await context.connection.client.session.get({ sessionID }, { signal: context.signal }).catch(error => {
      if ((error as { _tag?: unknown })?._tag === "SessionNotFoundError") throw new IntegrationAttachmentError("not-found")
      throw new IntegrationAttachmentError("unavailable")
    })
    await this.authorize(context)
    let location
    try { location = readLocationRef(session.location) } catch { throw new IntegrationAttachmentError("forbidden") }
    if (session.id !== sessionID || !sameLocation(location, context.location)) throw new IntegrationAttachmentError("forbidden")
    return session
  }

  private async call<M extends Method>(context: Context, method: M, input: IntegrationRpcValue<`${M}.input`>, sessionID?: string): Promise<IntegrationRpcValue<`${M}.output`>> {
    if (!integrationRpcSchemas[`${method}.input`].safeParse(input).success) throw new IntegrationAttachmentError("invalid")
    if (sessionID) await this.session(context, sessionID)
    else await this.authorize(context)
    let raw: unknown
    let failure: unknown
    try {
      context.signal.throwIfAborted()
      context.connection.assertCurrent()
      context.admission.assertCurrent()
      if (method === "attachHost" || method === "detachHost" || method === "installHost") context.admission.admit()
      const response = await context.connection.client.rpc.call({ rpcID: context.entry.rpc, method, input, location: { directory: context.location.directory } },
        { ...locationRequestOptions(context.location), signal: context.signal })
      raw = response.output
    } catch (error) { failure = error }
    if (sessionID) await this.session(context, sessionID)
    else await this.authorize(context)
    if (failure) {
      const rpc = failure as { _tag?: unknown; type?: unknown }
      throw new IntegrationAttachmentError(rpc._tag === "RpcError"
        ? rpc.type === "rpc.invalid_output" ? "non-conforming"
          : rpc.type === "rpc.unavailable" || rpc.type === "rpc.method_not_found" ? "unsupported" : "unavailable"
        : "unavailable")
    }
    const read = readIntegrationRpcOutput(`${method}.output`, raw)
    if (!read.ok) throw new IntegrationAttachmentError("non-conforming")
    // These are display strings; paths are refused beyond the schema's separator check.
    if (method === "hosts") {
      const hosts = read.value as IntegrationHostsResponse
      if (hosts.offers.some(offer => [offer.label, offer.document, offer.appVersion].some(value => value !== undefined && looksLikePath(value)))) {
        throw new IntegrationAttachmentError("non-conforming")
      }
    }
    return read.value
  }

  private async status(context: Context, sessionID?: string) {
    const status = await this.call(context, "status", {}, sessionID)
    if (status.integration.id !== context.entry.id || status.integration.family !== context.entry.family
      || (status.host?.appVersion !== undefined && looksLikePath(status.host.appVersion))) throw new IntegrationAttachmentError("non-conforming")
    if (status.host?.state === "unsupported") throw new IntegrationAttachmentError("unsupported")
  }

  private async writeHint(context: Context, sessionID: string, hint?: IntegrationAttachmentHint) {
    // Native session.update replaces metadata as a whole. Read immediately before it to preserve other owners' keys.
    const session = await this.session(context, sessionID)
    const metadata = { ...session.metadata }
    if (hint) metadata[INTEGRATION_ATTACHMENT_METADATA_KEY] = { ...hint }
    else delete metadata[INTEGRATION_ATTACHMENT_METADATA_KEY]
    context.connection.assertCurrent()
    context.signal.throwIfAborted()
    context.admission.admit()
    await context.connection.client.session.update({ sessionID, metadata }, { signal: context.signal })
    await this.session(context, sessionID)
  }
}
