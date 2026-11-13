import path from "node:path"
import { randomBytes } from "node:crypto"
import { z } from "zod"
import type { SettingsService } from "../settings/service"
import type { RemoteServerBrowseResponse } from "../api-types"
import { normalizeExplicitOrigin } from "../opencode/servers/endpoint"
import { CodeNomadServerClient, CodeNomadServerError } from "./client"
import { CodeNomadServerCredentials, type CodeNomadServerSecret } from "./credentials"
import { relayedFolderListing } from "./folders"
import { isRelayAuthority, RELAY_AUTHORITY_HEADER, RELAY_BOOTSTRAP } from "./relay-authority"
import { openSshForward, SSH_HOST, type SshForward } from "./ssh"

const Profile = z.object({ id: z.string(), baseUrl: z.string(), skipTlsVerify: z.boolean().default(false),
  ssh: z.object({ host: z.string().regex(SSH_HOST) }).optional() })
const Recent = z.object({ path: z.string().min(1).max(8192), projectName: z.string().max(1024).optional(), lastAccessed: z.number().finite() })
function pairingCode(link: string, origin: string): string {
  try {
    const url = new URL(link)
    if (url.protocol === "https:" && url.origin === origin && !url.username && !url.password && !url.search
      && url.pathname === "/remote-pair" && /^#[A-Za-z0-9_-]{32}$/.test(url.hash)
      && link === `${url.origin}/remote-pair${url.hash}`) return url.hash.slice(1)
  } catch { /* Return a stable error without the caller's link. */ }
  throw new CodeNomadServerError("pairing_expired")
}
export const BrowseBody = z.object({ path: z.string().max(8192).optional() }).strict()
export const ConnectBody = z.object({ username: z.string().min(1).max(1024).optional(), password: z.string().min(1).max(8192).optional(),
  pairingLink: z.string().max(8192).optional() }).strict()

/** `origin` is the server's address; over SSH it is resolved on `ssh`, and `scope` binds credentials to both. */
type ProfileAuthority = Readonly<{ id: string; origin: string; skipTlsVerify: boolean; key: string; proof: string; scope: string; ssh?: string }>
type ConnectionState = {
  credentials?: CodeNomadServerCredentials
  clients: Map<string, { authority: ProfileAuthority; client: CodeNomadServerClient }>
  pending: Map<CodeNomadServerClient, ProfileAuthority>
  queues: Map<string, Promise<unknown>>
  authorities: Map<string, ProfileAuthority>
  serverIds: Map<ProfileAuthority, string>
  tunnels: Map<ProfileAuthority, SshForward>
  owners: number
}
// Listeners of one backend share the SettingsService and one revocable authority.
const connections = new WeakMap<object, ConnectionState>()

/** Saved profiles are the sole network authority; cached clients own revocable transfers. */
export class RemoteServerBrowseManager {
  readonly #state: ConnectionState
  #closed = false

  constructor(private readonly settings: Pick<SettingsService, "getOwner" | "configYamlPathForAuthority">,
    private readonly openForward: typeof openSshForward = openSshForward) {
    let state = connections.get(settings)
    if (!state) {
      state = { clients: new Map(), pending: new Map(), queues: new Map(), authorities: new Map(), serverIds: new Map(), tunnels: new Map(), owners: 0 }
      connections.set(settings, state)
    }
    this.#state = state
    state.owners++
  }

  private get credentials() {
    return this.#state.credentials ??= new CodeNomadServerCredentials(path.join(path.dirname(this.settings.configYamlPathForAuthority()), "remote-server-credentials.json"))
  }

  private profile(id: string) {
    const values = this.settings.getOwner("state", "ui").remoteServers
    const profile = Array.isArray(values) ? values.map(value => Profile.safeParse(value)).find(value => value.success && value.data.id === id) : undefined
    if (!profile?.success) { this.remove(id); throw new CodeNomadServerError("unknown_server") }
    let origin: string
    try { origin = normalizeExplicitOrigin(profile.data.baseUrl) }
    catch (error) { this.remove(id); throw error }
    const ssh = profile.data.ssh?.host
    const scope = ssh === undefined ? origin : `ssh:${ssh}|${origin}`
    return { ...profile.data, origin, scope, ssh, key: `${scope}|${profile.data.skipTlsVerify}` }
  }

  private capture(id: string): ProfileAuthority {
    if (this.#closed) throw new CodeNomadServerError("unreachable")
    const profile = this.profile(id)
    let authority = this.#state.authorities.get(id)
    if (authority && authority.key !== profile.key) { this.remove(id); authority = undefined }
    // Disk identities also belong to this exact policy, including before a replacement login.
    this.credentials.read(id, profile.scope, profile.skipTlsVerify)
    if (!authority) {
      authority = Object.freeze({ id, origin: profile.origin, skipTlsVerify: profile.skipTlsVerify, key: profile.key, scope: profile.scope, ssh: profile.ssh, proof: randomBytes(32).toString("base64url") })
      this.#state.authorities.set(id, authority)
    }
    return authority
  }

  private assertCurrent(authority: ProfileAuthority) {
    if (this.#state.authorities.get(authority.id) !== authority) throw new CodeNomadServerError("unreachable")
    if (this.profile(authority.id).key !== authority.key) {
      this.remove(authority.id)
      throw new CodeNomadServerError("unreachable")
    }
  }

  /** Resolve only an existing exact generation: never recapture on failure. */
  assertProof(id: string, proof: unknown) {
    if (this.#closed) throw new CodeNomadServerError("unreachable")
    const authority = this.#state.authorities.get(id)
    if (!isRelayAuthority(proof) || !authority || authority.proof !== proof) throw new CodeNomadServerError("unreachable")
    this.assertCurrent(authority)
    return authority
  }

  private serial<T>(authority: ProfileAuthority, run: () => Promise<T>): Promise<T> {
    const id = authority.id
    const pending = (this.#state.queues.get(id) ?? Promise.resolve()).catch(() => {}).then(() => {
      if (this.#closed) throw new CodeNomadServerError("unreachable")
      this.assertCurrent(authority)
      return run()
    })
    this.#state.queues.set(id, pending)
    void pending.finally(() => { if (this.#state.queues.get(id) === pending) this.#state.queues.delete(id) }).catch(() => {})
    return pending
  }

  async connect(id: string, body: z.infer<typeof ConnectBody>, signal?: AbortSignal) {
    const profile = this.capture(id)
    body = { ...body }
    return this.serial(profile, async () => {
      signal?.throwIfAborted()
      // Validate the exact saved origin and link syntax before constructing any transport or resolving DNS.
      const code = body.pairingLink === undefined ? undefined : pairingCode(body.pairingLink, profile.origin)
      if (Boolean(body.username) !== Boolean(body.password)) throw new CodeNomadServerError("needs_credentials")
      let secret: CodeNomadServerSecret | undefined = code ? undefined : body.password
        ? { kind: "password", username: body.username!, password: body.password }
        : this.credentials.read(id, profile.scope, profile.skipTlsVerify)
      const client = new CodeNomadServerClient(profile.origin, secret, {
        signal,
        skipTlsVerify: profile.skipTlsVerify,
        dial: this.dial(profile),
        onSecretChanged: next => { secret = next },
        onRejected: () => { if (!code && !body.password && this.#state.authorities.get(id) === profile) this.remove(id) },
      })
      this.#state.pending.set(client, profile)
      try {
        if (code) secret = await client.pair(code)
        const result = await client.json<{ authenticated?: unknown; pairingRequired?: unknown }>("/api/auth/status")
        if (result.body?.pairingRequired === true) throw new CodeNomadServerError("needs_credentials")
        if (result.status !== 200) throw new CodeNomadServerError("unreachable")
        if (result.body?.authenticated !== true) throw new CodeNomadServerError("needs_credentials")
        this.assertCurrent(profile)
        if (this.#closed || client.closed) throw new CodeNomadServerError("unknown_server")
        // Publish only under the still-current authority after remote authentication.
        const previous = this.credentials.read(id, profile.scope, profile.skipTlsVerify)
        // Cookie rotation of one password principal preserves its generation; an explicit
        // replacement login/pairing revokes operations admitted under another identity.
        if (this.#state.serverIds.has(profile) && secret && (code || body.password && (previous?.kind !== "password" || previous.username !== body.username || previous.password !== body.password))) {
          this.remove(id)
          this.capture(id)
        }
        if (secret) this.credentials.set(id, profile.scope, secret, profile.skipTlsVerify)
        this.#state.clients.get(id)?.client.close()
        this.#state.clients.delete(id)
        return { ok: true }
      } finally { this.#state.pending.delete(client); client.close() }
    })
  }

  async browse(id: string, body: z.infer<typeof BrowseBody>, signal?: AbortSignal): Promise<RemoteServerBrowseResponse> {
    const profile = this.capture(id)
    body = { ...body }
    return this.serial(profile, async () => {
      signal?.throwIfAborted()
      const entry = this.client(profile)
      const suffix = body.path === undefined ? "" : `?path=${encodeURIComponent(body.path)}`
      if (!this.credentials.has(id, profile.scope, profile.skipTlsVerify)) {
        const status = await entry.client.json<{ pairingRequired?: unknown }>("/api/auth/status", { signal })
        if (status.body?.pairingRequired === true) throw new CodeNomadServerError("needs_credentials")
      }
      const folders = await entry.client.json<unknown>(`/api/filesystem${suffix}`, { signal })
      if (folders.status !== 200) throw new CodeNomadServerError("unreachable")
      const listing = relayedFolderListing(folders.body)
      const state = await entry.client.json<{ recentFolders?: unknown }>("/api/storage/state/ui", { signal })
      if (state.status !== 200 || !state.body || typeof state.body !== "object") throw new CodeNomadServerError("unreachable")
      const recents = Array.isArray(state.body.recentFolders) ? state.body.recentFolders.slice(0, 2000).flatMap(value => {
        const parsed = Recent.safeParse(value)
        return parsed.success ? [parsed.data] : []
      }) : []
      this.assertCurrent(profile)
      return { listing, recents }
    })
  }

  private client(profile: ProfileAuthority) {
      this.assertCurrent(profile)
      const id = profile.id
      let entry = this.#state.clients.get(id)
      if (entry?.authority !== profile) { entry?.client.close(); this.#state.clients.delete(id); entry = undefined }
      if (!entry) {
        const client = new CodeNomadServerClient(profile.origin, this.credentials.read(id, profile.scope, profile.skipTlsVerify), {
          skipTlsVerify: profile.skipTlsVerify,
          dial: this.dial(profile),
          onRejected: () => { if (this.#state.clients.get(id)?.client === client && this.#state.authorities.get(id) === profile) this.remove(id) },
          onSecretChanged: secret => {
            if (this.#state.clients.get(id)?.client === client && !client.closed) {
              this.assertCurrent(profile)
              this.credentials.set(id, profile.scope, secret, profile.skipTlsVerify)
            }
          },
        })
        entry = { authority: profile, client }
        this.#state.clients.set(id, entry)
      }
      return entry
  }

  async relay(id: string, target: string, init: RequestInit, proof?: unknown): Promise<Response> {
    const bootstrap = proof === RELAY_BOOTSTRAP
    const method = init.method ?? "GET"
    const metadata = target === "/api/meta" && method === "GET"
    if (bootstrap && !metadata && !(target === "/api/auth/status" && method === "GET")) throw new CodeNomadServerError("unreachable")
    const authority = proof === undefined || bootstrap ? this.capture(id) : this.assertProof(id, proof)
    const client = this.client(authority).client
    const mode = proof === undefined ? undefined : "observe-status"
    if (proof === undefined || !metadata) return client.fetch(target, init, mode)
    // Reuse the bounded JSON reader: identity is observed before a local proof is published.
    const result = await client.json<{ serverId?: unknown }>(target, init, mode)
    this.assertCurrent(authority)
    if (result.status !== 200 || typeof result.body?.serverId !== "string" || !result.body.serverId.trim()) {
      return new Response(result.body === undefined ? null : JSON.stringify(result.body), { status: result.status, headers: { "content-type": "application/json" } })
    }
    const known = this.#state.serverIds.get(authority)
    if (known && known !== result.body.serverId) {
      this.remove(id)
      throw new CodeNomadServerError("unknown_server")
    }
    this.#state.serverIds.set(authority, result.body.serverId)
    return Response.json(result.body, { headers: { [RELAY_AUTHORITY_HEADER]: authority.proof } })
  }

  /** The dial address of an SSH profile: its current owned forward, opened on demand and never persisted. */
  private dial(authority: ProfileAuthority) {
    const ssh = authority.ssh
    if (ssh === undefined) return undefined
    return async () => {
      if (!this.#state.owners) throw new CodeNomadServerError("unreachable")
      this.assertCurrent(authority)
      const tunnels = this.#state.tunnels
      let tunnel = tunnels.get(authority)
      if (!tunnel) {
        const url = new URL(authority.origin)
        const created: SshForward = this.openForward(ssh, `${url.hostname}:${url.port || (url.protocol === "https:" ? 443 : 80)}`,
          { onExit: () => { if (tunnels.get(authority) === created) tunnels.delete(authority) } })
        tunnels.set(authority, tunnel = created)
      }
      const port = await tunnel.ready
      this.assertCurrent(authority)
      if (tunnels.get(authority) !== tunnel) throw new CodeNomadServerError("unreachable")
      return { address: "127.0.0.1", family: 4 as const, port }
    }
  }


  /** Settings commits synchronously revoke removed or retargeted owners. */
  reconcile() {
    if (this.#closed) return
    for (const id of new Set([...this.credentials.ids(), ...this.#state.authorities.keys()])) {
      try {
        const profile = this.profile(id)
        const authority = this.#state.authorities.get(id)
        if (authority && authority.key !== profile.key) this.remove(id)
        else this.credentials.read(id, profile.scope, profile.skipTlsVerify)
      } catch { this.remove(id) }
    }
  }

  private remove(id: string) {
    const authority = this.#state.authorities.get(id)
    if (authority) this.#state.serverIds.delete(authority)
    if (authority) { this.#state.tunnels.get(authority)?.close(); this.#state.tunnels.delete(authority) }
    this.#state.authorities.delete(id)
    for (const [client, owner] of this.#state.pending) if (owner.id === id) client.close()
    this.#state.clients.get(id)?.client.close()
    this.#state.clients.delete(id)
    this.credentials.delete(id)
  }

  async forget(id: string) {
    if (this.#closed) throw new CodeNomadServerError("unreachable")
    this.remove(id)
    return { ok: true }
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    if (--this.#state.owners) return
    connections.delete(this.settings)
    this.#state.authorities.clear()
    this.#state.serverIds.clear()
    for (const { client } of this.#state.clients.values()) client.close()
    for (const client of this.#state.pending.keys()) client.close()
    this.#state.clients.clear()
    for (const tunnel of this.#state.tunnels.values()) tunnel.close()
    this.#state.tunnels.clear()
  }
}
