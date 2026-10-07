import type { PanelExtensionManifest, PanelExtensionSummary, PanelExtensionCatalog } from "../../../server/src/api-types"
import { CODENOMAD_API_BASE } from "./api-base"
import { authenticatedFetch } from "./auth-recovery"

async function request<T>(suffix: string, init?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(`${CODENOMAD_API_BASE ?? ""}/api/panel-extensions${suffix}`, {
    ...init, headers: { "Content-Type": "application/json" }, credentials: "include",
  })
  if (!response.ok) throw new Error("Panel extension request failed")
  return response.json()
}
export const panelExtensionsApi = {
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
