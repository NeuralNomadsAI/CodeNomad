import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import { ManifestSchema, PanelExtensionError, readPanelExtensionArchive } from "./archive"
import { PANEL_EXTENSION_API_VERSION, PANEL_EXTENSION_LIMITS, type PanelExtensionCatalog } from "./contract"

export const PANEL_EXTENSION_CATALOG_URL = "https://raw.githubusercontent.com/NeuralNomadsAI/CodeNomad-Extensions/main/catalog.json"
const CatalogSchema = z.object({ schemaVersion: z.literal(1), extensions: z.array(z.object({
  manifest: ManifestSchema.extend({ apiVersion: z.number().int().min(1).max(100), permissions: z.array(z.string().min(1).max(80)).max(8) }),
  description: z.string().trim().min(1).max(600),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  release: z.object({ tag: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/),
    asset: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}\.zip$/) }).strict(),
}).strict()).max(128) }).strict()

export function createPanelExtensionCatalog(fetcher: typeof globalThis.fetch = globalThis.fetch) {
  let cached: { value: PanelExtensionCatalog; expires: number } | undefined
  let pending: Promise<PanelExtensionCatalog> | undefined
  const load = async (): Promise<PanelExtensionCatalog> => {
    try {
      const bytes = await download(PANEL_EXTENSION_CATALOG_URL, 256 * 1024, true)
      const parsed = CatalogSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)))
      if (new Set(parsed.extensions.map(entry => entry.manifest.id)).size !== parsed.extensions.length) throw new PanelExtensionError("invalid")
      return { source: PANEL_EXTENSION_CATALOG_URL, entries: parsed.extensions.map(entry => ({ ...entry,
        compatible: entry.manifest.apiVersion === PANEL_EXTENSION_API_VERSION && isDeepStrictEqual(entry.manifest.permissions, ["session.context"]),
      })) }
    } catch (error) { throw error instanceof PanelExtensionError ? error : new PanelExtensionError("unavailable") }
  }
  const list = (fresh = false): Promise<PanelExtensionCatalog> => {
    // Display snapshots only. Inspection and installation never trust this cache.
    if (fresh) return load()
    if (cached && cached.expires > Date.now()) return Promise.resolve(cached.value)
    if (!pending) {
      pending = load().then(value => { cached = { value, expires: Date.now() + 30_000 }; return value }).finally(() => { pending = undefined })
    }
    return pending
  }
  const inspect = async (id: string, digest: string) => {
    const entry = (await list(true)).entries.find(entry => entry.manifest.id === id)
    if (!entry) throw new PanelExtensionError("missing")
    if (entry.digest !== digest) throw new PanelExtensionError("conflict")
    if (!entry.compatible) throw new PanelExtensionError("invalid")
    const url = `${entry.manifest.repository.replace(/\/$/, "")}/releases/download/${encodeURIComponent(entry.release.tag)}/${encodeURIComponent(entry.release.asset)}`
    const bytes = await download(url, PANEL_EXTENSION_LIMITS.archiveBytes)
    if (createHash("sha256").update(bytes).digest("hex") !== digest) throw new PanelExtensionError("conflict")
    const pkg = await readPanelExtensionArchive(bytes)
    if (!isDeepStrictEqual(pkg.manifest, entry.manifest)) throw new PanelExtensionError("conflict")
    return pkg
  }

  async function download(initial: string, limit: number, catalogue = false): Promise<Buffer> {
    const signal = AbortSignal.timeout(15_000)
    let next = initial
    try {
      for (let redirects = 0; redirects <= 3; redirects++) {
        const url = new URL(next)
        const allowed = catalogue ? url.href === PANEL_EXTENSION_CATALOG_URL : ["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(url.hostname)
        if (!allowed || url.protocol !== "https:" || url.port || url.username || url.password || url.hash) throw new PanelExtensionError("invalid")
        const response = await fetcher(url.href, { redirect: "manual", signal, credentials: "omit", headers: { Accept: catalogue ? "application/json" : "application/octet-stream" } })
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel()
          const target = response.headers.get("location")
          if (!target || catalogue) throw new PanelExtensionError("invalid")
          next = new URL(target, url).href
          continue
        }
        if (!response.ok || !response.body) { await response.body?.cancel(); throw new PanelExtensionError("unavailable") }
        if (Number(response.headers.get("content-length")) > limit) { await response.body.cancel(); throw new PanelExtensionError("limit") }
        const reader = response.body.getReader(), chunks: Uint8Array[] = []
        let size = 0
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > limit) throw new PanelExtensionError("limit")
            chunks.push(value)
          }
          return Buffer.concat(chunks, size)
        } finally { await reader.cancel(); reader.releaseLock() }
      }
      throw new PanelExtensionError("invalid")
    } catch (error) { throw error instanceof PanelExtensionError ? error : new PanelExtensionError("unavailable") }
  }
  return { list, inspect }
}
