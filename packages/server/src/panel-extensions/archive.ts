import { createHash } from "node:crypto"
import yauzl from "yauzl"
import { z } from "zod"
import { PANEL_EXTENSION_API4_PERMISSIONS, PANEL_EXTENSION_LIMITS, type PanelExtensionManifest } from "./contract"

// `session.context` plus a non-empty subset of the finite API 4 set, each once;
// prompts only with the gallery they annotate, bundle management only with reads. Order is free.
const Api4Permissions = z.array(z.enum(["session.context", ...PANEL_EXTENSION_API4_PERMISSIONS]))
  .min(2).max(PANEL_EXTENSION_API4_PERMISSIONS.length + 1)
  .refine(permissions => new Set(permissions).size === permissions.length && permissions.includes("session.context")
    && (!permissions.includes("session.images.prompts") || permissions.includes("session.images.read"))
    && (!permissions.includes("bundles.manage") || permissions.includes("bundles.read")))

export const ManifestFields = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,39}\.[a-z][a-z0-9-]{1,39}$/),
  name: z.string().trim().min(1).max(80),
  version: z.string().regex(/^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[a-zA-Z0-9.-]{1,40})?$/),
  author: z.string().trim().min(1).max(120),
  license: z.string().trim().min(1).max(80),
  repository: z.string().max(512).url().refine(value => {
    const url = new URL(value)
    return url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password
      && !url.search && !url.hash && /^\/[\w.-]+\/[\w.-]+\/?$/.test(url.pathname)
  }),
}).strict()
export const ManifestSchema = z.discriminatedUnion("apiVersion", [
  ManifestFields.extend({ apiVersion: z.literal(1), permissions: z.tuple([z.literal("session.context")]) }).strict(),
  ManifestFields.extend({ apiVersion: z.literal(2), permissions: z.tuple([z.literal("session.context"), z.literal("session.assets.read")]) }).strict(),
  ManifestFields.extend({ apiVersion: z.literal(3), permissions: z.tuple([z.literal("session.context"), z.literal("repository.workItems.read")]) }).strict(),
  ManifestFields.extend({ apiVersion: z.literal(4), permissions: Api4Permissions }).strict(),
])

export interface PanelExtensionPackage { manifest: PanelExtensionManifest; html: string; digest: string }
export class PanelExtensionError extends Error {
  constructor(readonly code: "invalid" | "conflict" | "limit" | "unavailable" | "missing" | "disabled") { super(code) }
}

export async function readPanelExtensionArchive(bytes: Buffer): Promise<PanelExtensionPackage> {
  if (!bytes.length || bytes.length > PANEL_EXTENSION_LIMITS.archiveBytes) throw new PanelExtensionError("limit")
  try {
    const files = await new Promise<Map<string, Buffer>>((resolve, reject) => {
      yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
        if (error || !zip) return reject(new PanelExtensionError("invalid"))
        const files = new Map<string, Buffer>()
        let ended = false
        const fail = () => { if (!ended) { ended = true; zip.close(); reject(new PanelExtensionError("invalid")) } }
        zip.on("error", fail)
        zip.on("end", () => { if (!ended) { ended = true; zip.close(); resolve(files) } })
        zip.on("entry", (entry: yauzl.Entry) => {
          const mode = entry.externalFileAttributes >>> 16
          const limit = entry.fileName === "manifest.json" ? 4096 : PANEL_EXTENSION_LIMITS.htmlBytes
          // No extraction: only these two root entries, no links, directories or paths.
          if (!["manifest.json", "panel.html"].includes(entry.fileName) || files.has(entry.fileName)
            || (mode & 0xf000) === 0xa000 || (entry.generalPurposeBitFlag & 1) !== 0 || entry.uncompressedSize > limit) return fail()
          zip.openReadStream(entry, (error, stream) => {
            if (error || !stream) return fail()
            const chunks: Buffer[] = []; let size = 0
            stream.on("error", fail)
            stream.on("data", chunk => {
              size += chunk.length
              if (size > limit) { stream.destroy(); fail() } else chunks.push(chunk)
            })
            stream.on("end", () => {
              if (ended) return
              files.set(entry.fileName, Buffer.concat(chunks))
              zip.readEntry()
            })
          })
        })
        zip.readEntry()
      })
    })
    if (files.size !== 2) throw new PanelExtensionError("invalid")
    const decoder = new TextDecoder("utf-8", { fatal: true })
    const manifest = ManifestSchema.parse(JSON.parse(decoder.decode(files.get("manifest.json"))))
    const html = decoder.decode(files.get("panel.html"))
    if (!html.trim()) throw new PanelExtensionError("invalid")
    return { manifest, html, digest: createHash("sha256").update(bytes).digest("hex") }
  } catch (error) { throw error instanceof PanelExtensionError ? error : new PanelExtensionError("invalid") }
}
