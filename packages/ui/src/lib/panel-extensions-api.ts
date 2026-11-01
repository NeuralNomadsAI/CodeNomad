import type {
  ForgeWorkItemKind, ForgeWorkItemsResult, PanelExtensionManifest, PanelExtensionSummary, PanelExtensionCatalog,
} from "../../../server/src/api-types"
import { CODENOMAD_API_BASE } from "./api-base"
import { authenticatedFetch } from "./auth-recovery"
import type { AssetTarget, AssetsResult, AssetReadResult } from "../../../server/src/opencode/session-pruning/assets-contract"
import type { GenerationTarget, ImagesResult } from "../../../server/src/opencode/session-pruning/assets-gallery-contract"
import type { PanelConversationStatus, PanelImagesStatus, PanelPreferencesSetStatus } from "../../../server/src/panel-extensions/contract"
import type { ImagesConversationRequest, ImagesConversationResponse } from "../../../server/src/server/routes/images-conversation-contract"
import { bundlesCatalogResultSchema, bundlesStateResultSchema, bundlesHostsResultSchema } from "../../../server/src/panel-extensions/bundles-contract"
import type { BundlesMountInput, BundlesManageInput, BundlesControlInput } from "../../../server/src/panel-extensions/bundles-contract"
import type { BundlesAck } from "../../../server/src/panel-extensions/bundles-lifecycle"
import { z } from "zod"

const opaque = z.string().regex(/^[a-f0-9]{32,64}$/)
const bundlesAck = z.union([z.object({ outcome: z.literal("confirming"), requestID: opaque }).strict(),
  z.object({ outcome: z.enum(["busy", "invalid"]) }).strict()])

export class PanelExtensionBusyError extends Error {
  constructor() { super("busy"); this.name = "PanelExtensionBusyError" }
}
export class PanelExtensionHttpError extends Error {
  constructor(readonly status: number) { super("Panel extension request failed"); this.name = "PanelExtensionHttpError" }
}

async function request<T>(suffix: string, init?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(`${CODENOMAD_API_BASE ?? ""}/api/panel-extensions${suffix}`, {
    ...init, headers: { "Content-Type": "application/json" }, credentials: "include",
  })
  if (response.status === 429) throw new PanelExtensionBusyError()
  if (!response.ok) throw new PanelExtensionHttpError(response.status)
  return response.json()
}
/** One API 4 method of one exact package; the host supplies instance and digest. */
const api4 = <T>(id: string, method: string, body: Record<string, unknown>, signal: AbortSignal) =>
  request<T>(`/${encodeURIComponent(id)}/${method}`, { method: "POST", body: JSON.stringify(body), signal })
type Authority = { instanceId: string; id: string; digest: string }
export const panelExtensionsApi4 = {
  bundlesMount: async (id: string, input: BundlesMountInput, signal: AbortSignal) =>
    z.object({ mountID: opaque }).strict().parse(await api4<unknown>(id, "bundles/mount", input, signal)),
  bundlesManage: async (id: string, input: BundlesManageInput, signal: AbortSignal): Promise<BundlesAck> =>
    bundlesAck.parse(await api4<unknown>(id, "bundles/manage", input, signal)),
  bundlesControl: async (id: string, input: BundlesControlInput, signal: AbortSignal) =>
    z.object({ ok: z.literal(true) }).strict().parse(await api4<unknown>(id, "bundles/control", input, signal)),
  bundlesCatalog: async ({ id, ...authority }: Authority, sessionID: string, signal: AbortSignal) =>
    bundlesCatalogResultSchema.parse(await api4<unknown>(id, "bundles/catalog", { ...authority, sessionID }, signal)),
  bundlesState: async ({ id, ...authority }: Authority, sessionID: string, signal: AbortSignal) =>
    bundlesStateResultSchema.parse(await api4<unknown>(id, "bundles/state", { ...authority, sessionID }, signal)),
  bundlesHosts: async ({ id, ...authority }: Authority, sessionID: string, integration: string, signal: AbortSignal) =>
    bundlesHostsResultSchema.parse(await api4<unknown>(id, "bundles/hosts", { ...authority, sessionID, integration }, signal)),
  images: ({ id, ...authority }: Authority, sessionID: string, cursor: string | undefined, signal: AbortSignal) =>
    api4<ImagesResult>(id, "images", { ...authority, sessionID, cursor }, signal),
  imageRead: ({ id, ...authority }: Authority, sessionID: string, target: AssetTarget, signal: AbortSignal) =>
    api4<AssetReadResult>(id, "imageRead", { ...authority, sessionID, target }, signal),
  imagesStatus: ({ id, ...authority }: Authority, scope: { sessionID: string } | { directory: string }, signal: AbortSignal) =>
    api4<PanelImagesStatus>(id, "imagesStatus", { ...authority, ...scope }, signal),
  prefillReferences: ({ id, ...authority }: Authority, sessionID: string, targets: Array<AssetTarget | GenerationTarget>, signal: AbortSignal) =>
    api4<{ paths: Array<string | null> }>(id, "prefillReferences", { ...authority, sessionID, targets }, signal),
  conversationStatus: ({ id, ...authority }: Authority, directory: string, sessionID: string | undefined, signal: AbortSignal) =>
    api4<PanelConversationStatus>(id, "conversationStatus", { ...authority, directory, sessionID }, signal),
  conversation: ({ id, ...authority }: Authority, { mode, ...input }: ImagesConversationRequest, signal: AbortSignal) =>
    api4<ImagesConversationResponse>(id, mode === "new" ? "conversationNew" : "conversationOpen", { ...authority, ...input }, signal),
  preferencesGet: ({ id, ...authority }: Authority, signal: AbortSignal) =>
    api4<{ status: "ok"; value: Record<string, unknown> } | { status: "unavailable" }>(id, "preferencesGet", authority, signal),
  preferencesSet: ({ id, ...authority }: Authority, value: unknown, signal: AbortSignal) =>
    api4<{ status: PanelPreferencesSetStatus }>(id, "preferencesSet", { ...authority, value }, signal),
}
export const panelExtensionsApi = {
  assets: (instanceId: string, id: string, digest: string, sessionID: string, cursor: string | undefined, signal: AbortSignal) =>
    request<Extract<AssetsResult, { status: "page" }>>(`/${encodeURIComponent(id)}/assets`, { method: "POST", body: JSON.stringify({ instanceId, digest, sessionID, cursor }), signal }),
  assetRead: (instanceId: string, id: string, digest: string, sessionID: string, target: AssetTarget, signal: AbortSignal) =>
    request<Extract<AssetReadResult, { status: "asset" }>>(`/${encodeURIComponent(id)}/assetRead`, { method: "POST", body: JSON.stringify({ instanceId, digest, sessionID, target }), signal }),
  workItems: (instanceId: string, id: string, digest: string, input: { kind: ForgeWorkItemKind; query: string; page: number; fresh: boolean }, signal: AbortSignal) =>
    request<ForgeWorkItemsResult>(`/${encodeURIComponent(id)}/workItems`, { method: "POST", body: JSON.stringify({ instanceId, digest, ...input }), signal }),
  workItemUrl: (instanceId: string, id: string, digest: string, kind: ForgeWorkItemKind, number: number, signal: AbortSignal) =>
    request<{ url: string }>(`/${encodeURIComponent(id)}/workItemUrl`, { method: "POST", body: JSON.stringify({ instanceId, digest, kind, number }), signal }),
  catalog: (refresh: boolean, signal: AbortSignal) => request<PanelExtensionCatalog>(`/catalog${refresh ? "?refresh=true" : ""}`, { signal }),
  inspectCatalog: (id: string, digest: string) => request<{ manifest: PanelExtensionManifest; digest: string }>("/catalog/inspect", {
    method: "POST", body: JSON.stringify({ id, digest }),
  }),
  installCatalog: (id: string, digest: string, previousDigest?: string) => request("/catalog/install", {
    method: "POST", body: JSON.stringify({ id, digest, previousDigest, acknowledged: true }),
  }),
  list: (signal?: AbortSignal) => request<PanelExtensionSummary[]>("", { signal }),
  inspect: (archiveBase64: string) => request<{ manifest: PanelExtensionManifest; digest: string }>("/inspect", {
    method: "POST", body: JSON.stringify({ archiveBase64 }),
  }),
  install: (archiveBase64: string, digest: string, previousDigest?: string) => request("", {
    method: "POST", body: JSON.stringify({ archiveBase64, digest, previousDigest, acknowledged: true }),
  }),
  activate: (id: string, digest: string, enabled: boolean) =>
    request(`/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ digest, enabled }) }),
  remove: (id: string, digest: string) => request(`/${encodeURIComponent(id)}`, { method: "DELETE", body: JSON.stringify({ digest }) }),
  panel: (instanceId: string, id: string, digest: string, signal: AbortSignal) =>
    request<{ html: string }>(`/${encodeURIComponent(id)}/panel?${new URLSearchParams({ instanceId, digest })}`, { signal }),
}
