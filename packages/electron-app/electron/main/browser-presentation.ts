import type { WebContents } from "electron"
const addresses = new WeakMap<WebContents, string>()
// ponytail: deny private native export surfaces; restore each behind an engine-safe logical-URL presenter.

export function isPrivatePreviewUrl(raw: string): boolean {
  try { return new URL(raw.startsWith("blob:") ? raw.slice(5) : raw).hostname.endsWith(".preview.localhost") } catch { return false }
}
export function restrictedBrowserGuest(guest: WebContents): boolean {
  if (addresses.has(guest)) return true
  try { return isPrivatePreviewUrl(guest.getURL?.() ?? "") } catch { return true }
}
export function setBrowserLogicalAddress(guest: WebContents, address?: string): void {
  if (!address) return
  const url = new URL(address)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || isPrivatePreviewUrl(address)) throw new Error("Invalid browser logical address")
  addresses.set(guest, url.origin)
}
export function browserPresentationTitle(guest: WebContents, raw: string): string {
  return restrictedBrowserGuest(guest) || isPrivatePreviewUrl(raw) ? addresses.get(guest) ?? "CodeNomad" : raw
}
