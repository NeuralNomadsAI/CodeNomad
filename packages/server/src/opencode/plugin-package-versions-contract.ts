import npa from "npm-package-arg"
import { z } from "zod"

export const PLUGIN_VERSIONS_RPC_ID = "codenomad.plugin-versions"
export const pluginVersionsSchema = z.array(z.object({
  target: z.string().min(1).max(4096),
  revision: z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/i),
  version: z.string().min(1).max(256).refine(value => value === value.trim() && !/[\x00-\x1f\x7f]/.test(value)),
}).strict()).max(64)

export function gitPluginRevision(target: unknown, version?: unknown): string | undefined {
  if (typeof target !== "string" || typeof version !== "string" || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(version) || target.length > 4096) return undefined
  try { return npa(target).type === "git" ? version : undefined } catch { return undefined }
}
