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
export const BrowseBody = z.object({ path: z.string().max(8192).optional() }).strict()
export const ConnectBody = z.object({ username: z.string().min(1).max(1024).optional(), password: z.string().min(1).max(8192).optional(),
  pairingLink: z.string().max(8192).optional() }).strict()

/** Only saved backend profiles can choose a network target. Owns no projects or event streams. */
export class RemoteServerBrowseManager {
  #credentials?: CodeNomadServerCredentials
  #clients = new Map<string, { key: string; client: CodeNomadServerClient }>()
  #pending = new Set<CodeNomadServerClient>()
  #queues = new Map<string, Promise<unknown>>()
  #closed = false

  constructor(private readonly settings: Pick<SettingsService, "getOwner" | "configYamlPathForAuthority">) {}

  private get credentials() {
    return this.#credentials ??= new CodeNomadServerCredentials(path.join(path.dirname(this.settings.configYamlPathForAuthority()), "remote-server-credentials.json"))
  }

  private profile(id: string) {
    const values = this.settings.getOwner("state", "ui").remoteServers
    const profile = Array.isArray(values) ? values.map(value => Profile.safeParse(value)).find(value => value.success && value.data.id === id) : undefined
    if (!profile?.success) { this.remove(id); throw new CodeNomadServerError("unknown_server") }
    const origin = normalizeExplicitOrigin(profile.data.baseUrl, true)
    return { ...profile.data, origin, key: `${origin}|${profile.data.skipTlsVerify}` }
  }

  private serial<T>(id: string, run: () => Promise<T>): Promise<T> {
    const pending = (this.#queues.get(id) ?? Promise.resolve()).catch(() => {}).then(() => {
      if (this.#closed) throw new CodeNomadServerError("unreachable")
      return run()
    })
    this.#queues.set(id, pending)
    void pending.finally(() => { if (this.#queues.get(id) === pending) this.#queues.delete(id) }).catch(() => {})
    return pending
  }

  connect(id: string, body: z.infer<typeof ConnectBody>) {
    return this.serial(id, async () => {
      const profile = this.profile(id)
      if (body.pairingLink !== undefined) throw new CodeNomadServerError("pairing_unavailable")
      if (Boolean(body.username) !== Boolean(body.password)) throw new CodeNomadServerError("needs_credentials")
      let secret: CodeNomadServerSecret | undefined = body.password
        ? { kind: "password", username: body.username!, password: body.password }
        : this.credentials.read(id, profile.origin)
      const client = new CodeNomadServerClient(profile.origin, secret, { skipTlsVerify: profile.skipTlsVerify, onSecretChanged: next => { secret = next } })
      this.#pending.add(client)
      try {
        const result = await client.json<{ authenticated?: unknown; pairingRequired?: unknown }>("/api/auth/status")
        if (result.body?.pairingRequired === true) throw new CodeNomadServerError("pairing_unavailable")
        if (result.status !== 200) throw new CodeNomadServerError("unreachable")
        if (result.body?.authenticated !== true) throw new CodeNomadServerError("needs_credentials")
        if (this.#closed || this.profile(id).key !== profile.key) throw new CodeNomadServerError("unknown_server")
        // Commit only after remote authentication succeeds; failed replacements keep the working identity.
        if (secret) this.credentials.set(id, profile.origin, secret)
        this.#clients.get(id)?.client.close()
        this.#clients.delete(id)
        return { ok: true }
      } finally { this.#pending.delete(client); client.close() }
    })
  }

  browse(id: string, body: z.infer<typeof BrowseBody>): Promise<RemoteServerBrowseResponse> {
    return this.serial(id, async () => {
      const profile = this.profile(id)
      let entry = this.#clients.get(id)
      if (entry?.key !== profile.key) { entry?.client.close(); this.#clients.delete(id); entry = undefined }
      if (!entry) {
        const client = new CodeNomadServerClient(profile.origin, this.credentials.read(id, profile.origin), {
          skipTlsVerify: profile.skipTlsVerify,
          onRejected: () => { this.credentials.delete(id); this.#clients.get(id)?.client.close(); this.#clients.delete(id) },
          onSecretChanged: secret => this.credentials.set(id, profile.origin, secret),
        })
        entry = { key: profile.key, client }
        this.#clients.set(id, entry)
      }
      const suffix = body.path === undefined ? "" : `?path=${encodeURIComponent(body.path)}`
      if (!this.credentials.has(id, profile.origin)) {
        const status = await entry.client.json<{ pairingRequired?: unknown }>("/api/auth/status")
        if (status.body?.pairingRequired === true) throw new CodeNomadServerError("pairing_unavailable")
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
      return { listing, recents }
    })
  }

  private remove(id: string) {
    this.#clients.get(id)?.client.close()
    this.#clients.delete(id)
    this.credentials.delete(id)
  }

  forget(id: string) { return this.serial(id, async () => { this.remove(id); return { ok: true } }) }

  close() {
    this.#closed = true
    for (const { client } of this.#clients.values()) client.close()
    for (const client of this.#pending) client.close()
    this.#clients.clear()
  }
}
