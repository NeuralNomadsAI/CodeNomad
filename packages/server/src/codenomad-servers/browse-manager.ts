import path from "node:path"
import { z } from "zod"
import type { SettingsService } from "../settings/service"
import type { RemoteServerBrowseResponse } from "../api-types"
import { normalizeExplicitOrigin } from "../opencode/servers/endpoint"
import { CodeNomadServerClient, CodeNomadServerError } from "./client"
import { CodeNomadServerCredentials, type CodeNomadServerSecret } from "./credentials"
import { relayedFolderListing } from "./folders"

const Profile = z.object({ id: z.string(), baseUrl: z.string(), skipTlsVerify: z.boolean().default(false) })
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

type ProfileAuthority = Readonly<{ id: string; origin: string; skipTlsVerify: boolean; key: string }>
type ConnectionState = {
  credentials?: CodeNomadServerCredentials
  clients: Map<string, { authority: ProfileAuthority; client: CodeNomadServerClient }>
  pending: Map<CodeNomadServerClient, ProfileAuthority>
  queues: Map<string, Promise<unknown>>
  authorities: Map<string, ProfileAuthority>
  owners: number
}
// Listeners of one backend share the SettingsService and one revocable authority.
const connections = new WeakMap<object, ConnectionState>()

/** Saved profiles are the sole network authority; cached clients own revocable transfers. */
export class RemoteServerBrowseManager {
  readonly #state: ConnectionState
  #closed = false

  constructor(private readonly settings: Pick<SettingsService, "getOwner" | "configYamlPathForAuthority">) {
    let state = connections.get(settings)
    if (!state) {
      state = { clients: new Map(), pending: new Map(), queues: new Map(), authorities: new Map(), owners: 0 }
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
    return { ...profile.data, origin, key: `${origin}|${profile.data.skipTlsVerify}` }
  }

  private capture(id: string): ProfileAuthority {
    if (this.#closed) throw new CodeNomadServerError("unreachable")
    const profile = this.profile(id)
    let authority = this.#state.authorities.get(id)
    if (authority && authority.key !== profile.key) { this.remove(id); authority = undefined }
    // Disk identities also belong to this exact policy, including before a replacement login.
    this.credentials.read(id, profile.origin, profile.skipTlsVerify)
    if (!authority) {
      authority = Object.freeze({ id, origin: profile.origin, skipTlsVerify: profile.skipTlsVerify, key: profile.key })
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

  async connect(id: string, body: z.infer<typeof ConnectBody>) {
    const profile = this.capture(id)
    body = { ...body }
    return this.serial(profile, async () => {
      // Validate the exact saved origin and link syntax before constructing any transport or resolving DNS.
      const code = body.pairingLink === undefined ? undefined : pairingCode(body.pairingLink, profile.origin)
      if (Boolean(body.username) !== Boolean(body.password)) throw new CodeNomadServerError("needs_credentials")
      let secret: CodeNomadServerSecret | undefined = code ? undefined : body.password
        ? { kind: "password", username: body.username!, password: body.password }
        : this.credentials.read(id, profile.origin, profile.skipTlsVerify)
      const client = new CodeNomadServerClient(profile.origin, secret, {
        skipTlsVerify: profile.skipTlsVerify,
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
        if (secret) this.credentials.set(id, profile.origin, secret, profile.skipTlsVerify)
        this.#state.clients.get(id)?.client.close()
        this.#state.clients.delete(id)
        return { ok: true }
      } finally { this.#state.pending.delete(client); client.close() }
    })
  }

  async browse(id: string, body: z.infer<typeof BrowseBody>): Promise<RemoteServerBrowseResponse> {
    const profile = this.capture(id)
    body = { ...body }
    return this.serial(profile, async () => {
      const entry = this.client(profile)
      const suffix = body.path === undefined ? "" : `?path=${encodeURIComponent(body.path)}`
      if (!this.credentials.has(id, profile.origin, profile.skipTlsVerify)) {
        const status = await entry.client.json<{ pairingRequired?: unknown }>("/api/auth/status")
        if (status.body?.pairingRequired === true) throw new CodeNomadServerError("needs_credentials")
      }
      const folders = await entry.client.json<unknown>(`/api/filesystem${suffix}`)
      if (folders.status !== 200) throw new CodeNomadServerError("unreachable")
      const listing = relayedFolderListing(folders.body)
      const state = await entry.client.json<{ recentFolders?: unknown }>("/api/storage/state/ui")
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
        const client = new CodeNomadServerClient(profile.origin, this.credentials.read(id, profile.origin, profile.skipTlsVerify), {
          skipTlsVerify: profile.skipTlsVerify,
          onRejected: () => { if (this.#state.clients.get(id)?.client === client) this.remove(id) },
          onSecretChanged: secret => {
            if (this.#state.clients.get(id)?.client === client && !client.closed) {
              this.assertCurrent(profile)
              this.credentials.set(id, profile.origin, secret, profile.skipTlsVerify)
            }
          },
        })
        entry = { authority: profile, client }
        this.#state.clients.set(id, entry)
      }
      return entry
  }

  /** Settings commits synchronously revoke removed or retargeted owners. */
  reconcile() {
    if (this.#closed) return
    for (const id of new Set([...this.credentials.ids(), ...this.#state.authorities.keys()])) {
      try {
        const profile = this.profile(id)
        const authority = this.#state.authorities.get(id)
        if (authority && authority.key !== profile.key) this.remove(id)
        else this.credentials.read(id, profile.origin, profile.skipTlsVerify)
      } catch { this.remove(id) }
    }
  }

  private remove(id: string) {
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
    for (const { client } of this.#state.clients.values()) client.close()
    for (const client of this.#state.pending.keys()) client.close()
    this.#state.clients.clear()
  }
}
