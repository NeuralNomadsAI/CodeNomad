import fs from "node:fs"
import path from "node:path"
import { createHash, randomBytes } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import { generateKeys, send, validateSubscription } from "./transport"

export type PushPrincipal = { id: string; channel: "tunnel" | "https"; origin: string }
export class PushInputError extends Error {}
export type PushEvent = { key: string; category: "needsInput" | "sessionDone"; instanceId: string; sessionId: string }
type Subscription = ReturnType<typeof validateSubscription>
type Keys = { publicKey: string; privateKey: string }
const PrincipalSchema = z.object({ id: z.string().min(1).max(256), channel: z.enum(["tunnel", "https"]), origin: z.string().url().max(1024) })
const Preferences = z.object({ v: z.literal(1), needsInput: z.boolean(), sessionDone: z.boolean() }).strict()
const Consent = z.object({
  subscription: z.unknown(), projects: z.array(z.string().min(1).max(256)).max(64), preferences: Preferences,
}).strict()
const EntrySchema = z.object({
  owner: z.string().regex(/^[a-f0-9]{64}$/), channel: z.enum(["tunnel", "https"]), origin: z.string().url(),
  channelEpoch: z.string(),
  device: z.string().max(256).optional(), subscription: z.unknown(), projects: z.array(z.string()).max(64),
  preferences: Preferences,
})
type Entry = Omit<z.infer<typeof EntrySchema>, "subscription"> & { subscription: Subscription }
type Route = { owner: string; instanceId: string; sessionId: string; expiresAt: number }
type Options = {
  file: string
  enabled(): boolean
  authority(principal: PushPrincipal): "active" | "suspended" | "revoked"
  projects(): string[]
  epoch?(publicKey: string): string
  channelEpoch?(principal: PushPrincipal): string
  qualifyRoute?(route: { instanceId: string; sessionId: string }): Promise<boolean>
  watch?(principal: PushPrincipal, revoked: () => void): () => void
  send?: typeof send
  validate?: typeof validateSubscription
  keys?: () => Keys
  subject?: string
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const ownerOf = (p: PushPrincipal) => hash(JSON.stringify([p.id, p.channel, p.origin]))
const TTL = 300_000

/** Private host-owned consent. Session credentials and payload contents never enter logs. */
export class PushService {
  private keys?: Keys
  private entries = new Map<string, Entry>()
  private principals = new Map<string, PushPrincipal>()
  private watches = new Map<string, () => void>()
  private routes = new Map<string, Route>()
  private seen = new Map<string, number>()
  private queue: Array<() => Promise<void>> = []
  private active = new Map<string, Set<AbortController>>()
  private running = 0
  private closed = false
  private loaded = false
  private nextLoadAt = 0
  private sweep: ReturnType<typeof setInterval>

  constructor(private readonly options: Options) {
    this.load()
    this.sweep = setInterval(() => {
      try {
        if (!this.available()) return
        for (const [owner, principal] of this.principals) {
          const authority = options.authority(principal)
          if (!options.enabled() || authority !== "active") {
            for (const controller of this.active.get(owner) ?? []) controller.abort()
          }
          if (authority === "revoked") this.removeOwner(owner)
        }
        this.prune()
      } catch { this.close() }
    }, 250)
    this.sweep.unref()
  }

  private load() {
    if (this.loaded || this.closed || !this.options.enabled() || Date.now() < this.nextLoadAt) return
    let parsed = false
    try {
      const doc = z.object({
        v: z.literal(1), epoch: z.string(), keys: z.object({ publicKey: z.string(), privateKey: z.string() }),
        entries: z.array(EntrySchema).max(128),
        routes: z.array(z.tuple([z.string(), z.object({ owner: z.string(), instanceId: z.string(), sessionId: z.string(), expiresAt: z.number() })])).max(1024),
      }).parse(JSON.parse(fs.readFileSync(this.options.file, "utf8")))
      parsed = true
      const entries = new Map<string, Entry>(), principals = new Map<string, PushPrincipal>(), routes = new Map<string, Route>()
      for (const raw of doc.epoch === (this.options.epoch?.(doc.keys.publicKey) ?? "") ? doc.entries : []) {
        // Password sessions live in memory. Device identity is revalidated before any IO.
        if (!raw.device) continue
        const principal: PushPrincipal = { id: `remote-device:${raw.device}`, channel: raw.channel, origin: raw.origin }
        if (ownerOf(principal) !== raw.owner
          || raw.channelEpoch !== (this.options.channelEpoch?.(principal) ?? "")) continue
        const entry = { ...raw, subscription: this.validate(raw.subscription) }
        entries.set(hash(entry.subscription.endpoint), entry)
        principals.set(raw.owner, principal)
      }
      for (const [token, route] of doc.routes) {
        if (route.expiresAt > Date.now() && principals.has(route.owner)) routes.set(token, route)
      }
      this.keys = doc.keys
      this.entries = entries
      this.principals = principals
      this.routes = routes
      if (entries.size !== doc.entries.length) this.persist()
      this.loaded = true
    } catch (error: any) {
      if (error.code === "ENOENT" && !parsed) this.loaded = true
      else this.nextLoadAt = Date.now() + 5000
    }
  }
  private available() {
    this.load()
    return this.loaded && !this.closed
  }
  private requireStorage() {
    if (!this.available()) throw new Error("Private push storage unavailable")
  }

  private validate(value: unknown): Subscription {
    try { return (this.options.validate ?? validateSubscription)(value) }
    catch { throw new PushInputError("Invalid push subscription") }
  }
  interested(instanceId: string): boolean {
    if (!this.options.enabled() || !this.available()) return false
    return [...this.entries.values()].some(entry => entry.projects.includes(instanceId)
      && (entry.preferences.needsInput || entry.preferences.sessionDone)
      && this.options.authority(this.principals.get(entry.owner)!) === "active")
  }
  status(principal: PushPrincipal) {
    const available = this.available(), enabled = available && this.options.enabled()
    return { enabled, subscribed: available && this.hasOwner(ownerOf(principal)),
      ...(!available && this.options.enabled() ? { unavailable: true } : {}),
      ...(enabled && this.keys ? { publicKey: this.keys.publicKey } : {}) }
  }
  consent(principal: PushPrincipal) {
    PrincipalSchema.parse(principal)
    if (!this.options.enabled() || this.closed) throw new PushInputError("Web Push disabled")
    this.requireStorage()
    if (principal.id === "auth-disabled" || this.options.authority(principal) !== "active") throw new PushInputError("Push principal refused")
    this.keys ??= (this.options.keys ?? generateKeys)()
    this.persist()
    return { publicKey: this.keys.publicKey }
  }
  subscribe(principal: PushPrincipal, value: unknown) {
    PrincipalSchema.parse(principal)
    if (!this.options.enabled() || this.closed) throw new PushInputError("Web Push disabled")
    this.requireStorage()
    if (principal.id === "auth-disabled" || this.options.authority(principal) !== "active") throw new PushInputError("Push principal refused")
    const consent = Consent.parse(value), subscription = this.validate(consent.subscription)
    const projects = new Set(this.options.projects())
    if (consent.projects.some(id => !projects.has(id))) throw new PushInputError("Push project unavailable")
    const owner = ownerOf(principal), id = hash(subscription.endpoint), existing = this.entries.get(id)
    if (existing && existing.owner !== owner) throw new PushInputError("Push subscription already owned")
    if (!existing && (this.entries.size >= 128 || [...this.entries.values()].filter(e => e.owner === owner).length >= 8)) throw new PushInputError("Push subscription limit")
    const entry: Entry = { owner, channel: principal.channel, origin: principal.origin,
      channelEpoch: this.options.channelEpoch?.(principal) ?? "",
      ...(principal.id.startsWith("remote-device:") ? { device: principal.id.slice(14) } : {}),
      subscription, projects: [...new Set(consent.projects)], preferences: consent.preferences }
    const next = new Map(this.entries).set(id, entry)
    this.keys ??= (this.options.keys ?? generateKeys)()
    this.persist(next)
    this.entries = next
    this.principals.set(owner, { ...principal })
    if (!this.watches.has(owner) && this.options.watch) {
      this.watches.set(owner, this.options.watch(principal, () => this.removeOwner(owner)))
    }
    return { publicKey: this.keys.publicKey }
  }
  unsubscribe(principal: PushPrincipal) { this.requireStorage(); this.removeOwner(ownerOf(principal)) }
  revoke(id?: string, channel?: "tunnel") {
    if (!this.loaded) return
    for (const [owner, p] of this.principals) {
      if ((id === undefined || p.id === id || p.id === `remote-device:${id}`) && (!channel || p.channel === channel)) this.removeOwner(owner, false)
    }
    this.persist()
  }
  async resolve(principal: PushPrincipal, token: string) {
    if (!this.available()) return undefined
    const route = this.routes.get(token)
    const current = () => this.options.enabled() && this.options.authority(principal) === "active" && route
      && this.routes.get(token) === route && route.owner === ownerOf(principal) && route.expiresAt > Date.now()
      && this.options.projects().includes(route.instanceId) && this.hasOwner(route.owner)
    if (!current() || !route) return undefined
    try { if (this.options.qualifyRoute && !await this.options.qualifyRoute(route)) return undefined }
    catch { return undefined }
    if (!current()) return undefined
    return { instanceId: route.instanceId, sessionId: route.sessionId }
  }
  async publish(event: PushEvent): Promise<void> {
    if (!this.options.enabled() || !this.available()) return
    this.prune()
    const expiresAt = Date.now() + TTL
    await Promise.all([...this.entries].map(([id, entry]) => {
      const principal = this.principals.get(entry.owner)
      if (!principal || this.options.authority(principal) !== "active" || !entry.projects.includes(event.instanceId)
        || !entry.preferences[event.category] || !this.options.projects().includes(event.instanceId)) return
      const key = hash(JSON.stringify([event.key, id]))
      if (this.seen.has(key) || this.seen.size >= 4096 || this.queue.length + this.running >= 256) return
      this.seen.set(key, expiresAt)
      return new Promise<void>(resolve => {
        this.queue.push(async () => {
          try { await this.dispatch(id, entry, event, expiresAt) } finally { resolve() }
        })
        this.drain()
      })
    }))
  }
  private drain() {
    while (!this.closed && this.running < 4 && this.queue.length) {
      const job = this.queue.shift()!
      this.running++
      void job().catch(() => {}).finally(() => { this.running--; this.drain() })
    }
  }
  private async dispatch(id: string, entry: Entry, event: PushEvent, expiresAt: number) {
    const controller = new AbortController(), deadline = AbortSignal.timeout(20_000)
    const signal = AbortSignal.any([controller.signal, deadline])
    const controllers = this.active.get(entry.owner) ?? new Set()
    controllers.add(controller)
    this.active.set(entry.owner, controllers)
    const current = () => !signal.aborted && !this.closed && this.options.enabled()
      && this.entries.get(id) === entry && Date.now() < expiresAt
      && this.options.projects().includes(event.instanceId)
      && this.options.authority(this.principals.get(entry.owner)!) === "active"
    try {
      if (!current()) return
      const token = randomBytes(24).toString("base64url")
      this.routes.set(token, { owner: entry.owner, instanceId: event.instanceId, sessionId: event.sessionId, expiresAt })
      this.prune()
      this.persist()
      const payload = JSON.stringify({ v: 1, title: "CodeNomad",
        body: event.category === "needsInput" ? "A conversation needs your answer." : "A conversation finished.",
        notificationId: randomBytes(16).toString("hex"), route: token, expiresAt })
      for (let attempt = 0; attempt < 3 && current(); attempt++) {
        const result = await (this.options.send ?? send)(entry.subscription, payload, {
          ...this.keys!, subject: this.options.subject ?? "https://github.com/NeuralNomadsAI/CodeNomad",
        }, signal)
        if (!current()) return
        if (result.status === 404 || result.status === 410) {
          this.entries.delete(id)
          if (!this.hasOwner(entry.owner)) this.removeOwner(entry.owner, false)
          this.persist()
          return
        }
        if (result.status !== 429 && result.status < 500) return
        const wait = Math.max(1000, result.retryAfterMs ?? 1000 * 2 ** attempt)
        if (wait >= 20_000 || Date.now() + wait >= expiresAt) return
        await delay(wait, undefined, { signal })
      }
    } catch { /* Delivery failures are bounded and contain no endpoint or payload logs. */ }
    finally {
      controllers.delete(controller)
      if (!controllers.size) this.active.delete(entry.owner)
    }
  }
  private hasOwner(owner: string) { return [...this.entries.values()].some(e => e.owner === owner) }
  private removeOwner(owner: string, persist = true) {
    for (const controller of this.active.get(owner) ?? []) controller.abort()
    for (const [id, entry] of this.entries) if (entry.owner === owner) this.entries.delete(id)
    for (const [token, route] of this.routes) if (route.owner === owner) this.routes.delete(token)
    this.principals.delete(owner)
    this.watches.get(owner)?.()
    this.watches.delete(owner)
    if (persist) this.persist()
  }
  private prune() {
    for (const [key, expiry] of this.seen) if (expiry <= Date.now()) this.seen.delete(key)
    for (const [token, route] of this.routes) if (route.expiresAt <= Date.now()) this.routes.delete(token)
    while (this.routes.size > 1024) this.routes.delete(this.routes.keys().next().value!)
  }
  private persist(entries = this.entries) {
    if (!this.keys) return
    fs.mkdirSync(path.dirname(this.options.file), { recursive: true })
    const tmp = `${this.options.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
    try {
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, epoch: this.options.epoch?.(this.keys.publicKey) ?? "", keys: this.keys,
        entries: [...entries.values()], routes: [...this.routes] }), { mode: 0o600, flag: "wx" })
      fs.chmodSync(tmp, 0o600)
      fs.renameSync(tmp, this.options.file)
    } finally { try { fs.unlinkSync(tmp) } catch { /* Already published. */ } }
  }
  close() {
    this.closed = true
    clearInterval(this.sweep)
    for (const release of this.watches.values()) release()
    this.watches.clear()
    for (const controllers of this.active.values()) for (const controller of controllers) controller.abort()
    // Drain skipped jobs so every publish caller settles on shutdown.
    for (const job of this.queue.splice(0)) void job()
  }
}
