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

/** Saved profiles are the sole network authority; cached clients own revocable transfers. */
export class RemoteServerBrowseManager {
  #credentials?: CodeNomadServerCredentials
  #clients = new Map<string, { key: string; client: CodeNomadServerClient }>()
  #pending = new Set<CodeNomadServerClient>()
  #pendingProfiles = new Map<CodeNomadServerClient, { id: string; key: string }>()
  #queues = new Map<string, Promise<unknown>>()
  #epochs = new Map<string, number>()
  #closed = false

  constructor(private readonly settings: Pick<SettingsService, "getOwner" | "configYamlPathForAuthority">) {}

  private get credentials() {
    return this.#credentials ??= new CodeNomadServerCredentials(path.join(path.dirname(this.settings.configYamlPathForAuthority()), "remote-server-credentials.json"))
  }

  private profile(id: string) {
    const values = this.settings.getOwner("state", "ui").remoteServers
    const profile = Array.isArray(values) ? values.map(value => Profile.safeParse(value)).find(value => value.success && value.data.id === id) : undefined
    if (!profile?.success) { this.remove(id); throw new CodeNomadServerError("unknown_server") }
    const origin = normalizeExplicitOrigin(profile.data.baseUrl)
    return { ...profile.data, origin, key: `${origin}|${profile.data.skipTlsVerify}` }
  }

  private serial<T>(id: string, run: () => Promise<T>): Promise<T> {
    const epoch = this.#epochs.get(id)
    const pending = (this.#queues.get(id) ?? Promise.resolve()).catch(() => {}).then(() => {
      if (this.#closed || this.#epochs.get(id) !== epoch) throw new CodeNomadServerError("unreachable")
      return run()
    })
    this.#queues.set(id, pending)
    void pending.finally(() => { if (this.#queues.get(id) === pending) this.#queues.delete(id) }).catch(() => {})
    return pending
  }

  connect(id: string, body: z.infer<typeof ConnectBody>, signal?: AbortSignal) {
    return this.serial(id, async () => {
      signal?.throwIfAborted()
      const profile = this.profile(id)
      // Validate the exact saved origin and link syntax before constructing any transport or resolving DNS.
      const code = body.pairingLink === undefined ? undefined : pairingCode(body.pairingLink, profile.origin)
      if (Boolean(body.username) !== Boolean(body.password)) throw new CodeNomadServerError("needs_credentials")
      let secret: CodeNomadServerSecret | undefined = code ? undefined : body.password
        ? { kind: "password", username: body.username!, password: body.password }
        : this.credentials.read(id, profile.origin)
      const client = new CodeNomadServerClient(profile.origin, secret, {
        signal,
        skipTlsVerify: profile.skipTlsVerify,
        onSecretChanged: next => { secret = next },
        onRejected: () => { if (!code && !body.password) this.remove(id) },
      })
      this.#pending.add(client)
      this.#pendingProfiles.set(client, { id, key: profile.key })
      try {
        if (code) secret = await client.pair(code)
        const result = await client.json<{ authenticated?: unknown; pairingRequired?: unknown }>("/api/auth/status")
        if (result.body?.pairingRequired === true) throw new CodeNomadServerError("needs_credentials")
        if (result.status !== 200) throw new CodeNomadServerError("unreachable")
        if (result.body?.authenticated !== true) throw new CodeNomadServerError("needs_credentials")
        if (this.#closed || client.closed || this.profile(id).key !== profile.key) throw new CodeNomadServerError("unknown_server")
        // Commit only after remote authentication succeeds; failed replacements keep the working identity.
        if (secret) this.credentials.set(id, profile.origin, secret)
        this.#clients.get(id)?.client.close()
        this.#clients.delete(id)
        return { ok: true }
      } finally { this.#pending.delete(client); this.#pendingProfiles.delete(client); client.close() }
    })
  }

  browse(id: string, body: z.infer<typeof BrowseBody>, signal?: AbortSignal): Promise<RemoteServerBrowseResponse> {
    return this.serial(id, async () => {
      signal?.throwIfAborted()
      const { profile, entry } = this.client(id)
      const suffix = body.path === undefined ? "" : `?path=${encodeURIComponent(body.path)}`
      if (!this.credentials.has(id, profile.origin)) {
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
      return { listing, recents }
    })
  }

  private client(id: string) {
      if (this.#closed) throw new CodeNomadServerError("unreachable")
      const profile = this.profile(id)
      let entry = this.#clients.get(id)
      if (entry?.key !== profile.key) { entry?.client.close(); this.#clients.delete(id); entry = undefined }
      if (!entry) {
        const client = new CodeNomadServerClient(profile.origin, this.credentials.read(id, profile.origin), {
          skipTlsVerify: profile.skipTlsVerify,
          onRejected: () => { if (this.#clients.get(id)?.client === client) this.remove(id) },
          onSecretChanged: secret => { if (this.#clients.get(id)?.client === client && !client.closed) this.credentials.set(id, profile.origin, secret) },
        })
        entry = { key: profile.key, client }
        this.#clients.set(id, entry)
      }
      return { profile, entry }
  }

  relay(id: string, target: string, init: RequestInit): Promise<Response> {
    return this.client(id).entry.client.fetch(target, init)
  }

  /** Settings commits synchronously revoke removed or retargeted owners. */
  reconcile() {
    for (const id of new Set([...this.credentials.ids(), ...this.#clients.keys()])) {
      try {
        const profile = this.profile(id)
        const entry = this.#clients.get(id)
        if (entry && entry.key !== profile.key) this.remove(id)
        else this.credentials.read(id, profile.origin)
      } catch { this.remove(id) }
    }
    for (const [client, owner] of this.#pendingProfiles) {
      try { if (this.profile(owner.id).key !== owner.key) client.close() }
      catch { client.close() }
    }
  }

  private remove(id: string) {
    this.#epochs.set(id, (this.#epochs.get(id) ?? 0) + 1)
    for (const [client, owner] of this.#pendingProfiles) if (owner.id === id) client.close()
    this.#clients.get(id)?.client.close()
    this.#clients.delete(id)
    this.credentials.delete(id)
  }

  async forget(id: string) { this.remove(id); return { ok: true } }

  close() {
    this.#closed = true
    for (const { client } of this.#clients.values()) client.close()
    for (const client of this.#pending) client.close()
    this.#clients.clear()
  }
}
