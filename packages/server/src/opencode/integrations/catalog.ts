import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Logger } from "../../logger"
import { INTEGRATION_CATALOG_MAX_BYTES, integrationCatalogSchema, type IntegrationCatalog } from "./contract"

/**
 * The reviewed catalog's only remote source (D17, D20): the releases of the integrations repository. CodeNomad
 * reads the `catalog.json` asset of the newest `catalog-v<n>` release, never the repository's "latest" release.
 */
export const INTEGRATION_CATALOG_RELEASES_URL = "https://api.github.com/repos/NeuralNomadsAI/opencode-integrations/releases?per_page=100"
export const INTEGRATION_CATALOG_ASSET = "catalog.json"
/** Two reads closer than this share one remote request, whatever its outcome. */
export const INTEGRATION_CATALOG_CACHE_MS = 30_000
/** Bound on one whole refresh: the release list, then the asset. */
export const INTEGRATION_CATALOG_TIMEOUT_MS = 10_000
const RELEASE_LIST_MAX_BYTES = 1024 * 1024
const CATALOG_TAG = /^catalog-v(0|[1-9][0-9]{0,8})$/

export type IntegrationCatalogState = "fresh" | "stale" | "unavailable"

/** `fresh`: the last remote read succeeded; `stale`: it failed and the last valid catalog is served;
 * `unavailable`: no valid catalog is known, with an empty list. */
export interface IntegrationCatalogView {
  state: IntegrationCatalogState
  /** When the served catalog was read from its release (ISO 8601). */
  fetchedAt?: string
  catalog: IntegrationCatalog
}

interface KnownCatalog { catalog: IntegrationCatalog; fetchedAt: string; tag: string }
interface Release { tag: string; assetUrl: string }

export class IntegrationCatalogError extends Error {
  constructor(readonly reason: "network" | "status" | "too-large" | "invalid" | "no-release") {
    super(`Integration catalog unavailable (${reason})`)
    this.name = "IntegrationCatalogError"
  }
}

export interface IntegrationCatalogSourceOptions {
  releasesUrl?: string
  fetch?: typeof fetch
  now?: () => number
  /** Where the last valid catalog persists across restarts; none keeps it in memory only. */
  stateFile?: string
  logger?: Pick<Logger, "debug" | "warn">
  cacheMs?: number
  timeoutMs?: number
}

/**
 * The last valid reviewed catalog. The 30 s cache covers the remote document only, never daemon state. A refresh
 * runs alone (concurrent reads join it), so an older answer can never replace a newer one. A failed read keeps the
 * last valid catalog, persisted in CodeNomad's state folder; no catalog is bundled.
 */
export class IntegrationCatalogSource {
  private known?: KnownCatalog
  private loaded?: Promise<void>
  private attempt?: { at: number; ok: boolean }
  private refreshing?: Promise<void>
  // Conditional requests: a 304 answer reuses the selected release and costs no GitHub rate limit.
  private listTag?: { etag: string; release: Release | null }
  private readonly releasesUrl: string
  private readonly fetch: typeof fetch
  private readonly now: () => number

  constructor(private readonly options: IntegrationCatalogSourceOptions = {}) {
    this.releasesUrl = options.releasesUrl ?? INTEGRATION_CATALOG_RELEASES_URL
    this.fetch = options.fetch ?? fetch
    this.now = options.now ?? Date.now
  }

  async read(): Promise<IntegrationCatalogView> {
    await (this.loaded ??= this.loadPersisted())
    const fresh = this.attempt !== undefined && this.now() - this.attempt.at < (this.options.cacheMs ?? INTEGRATION_CATALOG_CACHE_MS)
    if (!fresh) await (this.refreshing ??= this.refresh().finally(() => { this.refreshing = undefined }))
    return this.view()
  }

  private view(): IntegrationCatalogView {
    if (!this.known) return { state: "unavailable", catalog: { schemaVersion: 1, integrations: [] } }
    return { state: this.attempt?.ok ? "fresh" : "stale", fetchedAt: this.known.fetchedAt, catalog: this.known.catalog }
  }

  private async refresh(): Promise<void> {
    const signal = AbortSignal.timeout(this.options.timeoutMs ?? INTEGRATION_CATALOG_TIMEOUT_MS)
    try {
      const release = await this.newestRelease(signal)
      if (!release) throw new IntegrationCatalogError("no-release")
      if (this.known?.tag !== release.tag) {
        const catalog = parseCatalog(await this.download(release.assetUrl, "application/octet-stream", INTEGRATION_CATALOG_MAX_BYTES, signal))
        this.known = { catalog, fetchedAt: new Date(this.now()).toISOString(), tag: release.tag }
        await this.persist(this.known)
      }
      this.attempt = { at: this.now(), ok: true }
    } catch (error) {
      this.attempt = { at: this.now(), ok: false }
      // The reason only: a refused document is never echoed.
      this.options.logger?.debug({ reason: error instanceof IntegrationCatalogError ? error.reason : "network" }, "Integration catalog refresh failed")
    }
  }

  private async newestRelease(signal: AbortSignal): Promise<Release | null> {
    const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "CodeNomad", "x-github-api-version": "2022-11-28" }
    if (this.listTag) headers["if-none-match"] = this.listTag.etag
    const response = await this.request(this.releasesUrl, headers, signal)
    if (response.status === 304 && this.listTag) {
      await response.body?.cancel()
      return this.listTag.release
    }
    const body = await readBounded(response, RELEASE_LIST_MAX_BYTES)
    const release = selectCatalogRelease(parseJson(body), new URL(this.releasesUrl).origin)
    const etag = response.headers.get("etag")
    this.listTag = etag ? { etag, release } : undefined
    return release
  }

  private async download(url: string, accept: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
    return readBounded(await this.request(url, { accept, "user-agent": "CodeNomad" }, signal), maxBytes)
  }

  private async request(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
    let response: Response
    try {
      response = await this.fetch(url, { headers, signal, redirect: "follow" })
    } catch {
      throw new IntegrationCatalogError("network")
    }
    if (response.status !== 200 && response.status !== 304) {
      await response.body?.cancel().catch(() => undefined)
      throw new IntegrationCatalogError("status")
    }
    return response
  }

  private async loadPersisted(): Promise<void> {
    const file = this.options.stateFile
    if (!file) return
    try {
      const raw = JSON.parse(await readFile(file, "utf8")) as { tag?: unknown; fetchedAt?: unknown; catalog?: unknown }
      const catalog = integrationCatalogSchema.safeParse(raw.catalog)
      if (catalog.success && typeof raw.tag === "string" && CATALOG_TAG.test(raw.tag)
        && typeof raw.fetchedAt === "string" && !Number.isNaN(Date.parse(raw.fetchedAt))
        && Buffer.byteLength(JSON.stringify(catalog.data)) <= INTEGRATION_CATALOG_MAX_BYTES) {
        this.known ??= { catalog: catalog.data, fetchedAt: raw.fetchedAt, tag: raw.tag }
      }
    } catch {
      // No or unreadable state: start without a known catalog.
    }
  }

  private async persist(known: KnownCatalog): Promise<void> {
    const file = this.options.stateFile
    if (!file) return
    try {
      await mkdir(path.dirname(file), { recursive: true })
      const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      await writeFile(temporary, `${JSON.stringify({ version: 1, tag: known.tag, fetchedAt: known.fetchedAt, catalog: known.catalog })}\n`, { mode: 0o600 })
      await rename(temporary, file)
    } catch (error) {
      this.options.logger?.warn({ err: error }, "Unable to keep the integration catalog")
    }
  }
}

/**
 * The newest published `catalog-v<n>` release (highest `n`, drafts and prereleases ignored) that carries the
 * catalog asset, read from a GitHub release list. Its asset is fetched through the API origin only.
 */
export function selectCatalogRelease(list: unknown, apiOrigin: string): Release | null {
  if (!Array.isArray(list)) throw new IntegrationCatalogError("invalid")
  let best: { number: number; release: Release } | null = null
  for (const item of list) {
    if (!item || typeof item !== "object") continue
    const release = item as { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown }
    const tag = typeof release.tag_name === "string" ? CATALOG_TAG.exec(release.tag_name) : null
    if (!tag || release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets)) continue
    const asset = (release.assets as Array<{ name?: unknown; url?: unknown; size?: unknown } | null>)
      .find(candidate => candidate?.name === INTEGRATION_CATALOG_ASSET)
    if (!asset || typeof asset.url !== "string" || !sameOrigin(asset.url, apiOrigin)) continue
    if (typeof asset.size === "number" && asset.size > INTEGRATION_CATALOG_MAX_BYTES) continue
    const number = Number(tag[1])
    if (!best || number > best.number) best = { number, release: { tag: release.tag_name as string, assetUrl: asset.url } }
  }
  return best?.release ?? null
}

/** A catalog document: UTF-8 JSON within `integrationCatalogSchema` (bounds and uniqueness included). */
export function parseCatalog(bytes: Uint8Array): IntegrationCatalog {
  const parsed = integrationCatalogSchema.safeParse(parseJson(bytes))
  if (!parsed.success) throw new IntegrationCatalogError("invalid")
  return parsed.data
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    throw new IntegrationCatalogError("invalid")
  }
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin
  } catch {
    return false
  }
}

/** Reads at most `maxBytes`, cancelling the transfer as soon as the body exceeds them. */
async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new IntegrationCatalogError("too-large")
  }
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new IntegrationCatalogError("too-large")
      }
      chunks.push(value)
    }
  } catch (error) {
    throw error instanceof IntegrationCatalogError ? error : new IntegrationCatalogError("network")
  }
  return Buffer.concat(chunks)
}
