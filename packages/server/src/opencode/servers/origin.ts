export type EndpointErrorCode = "invalid_origin" | "dns" | "network" | "tls" | "redirect" | "timeout" | "response_limit" | "probe_path" | "custom_ca_unsupported"
  | "ssh_unavailable" | "ssh_host_key" | "ssh_auth"

/** Diagnostics contain only a stable code, never a URL, credential or upstream error. */
export class ExplicitEndpointError extends Error {
  constructor(readonly code: EndpointErrorCode) { super(code); this.name = "ExplicitEndpointError" }
}

/** Synchronous origin validation shared by registry metadata and network admission. */
export function normalizeExplicitOrigin(value: string): string {
  let url: URL
  try {
    // Inspect the supplied syntax before WHATWG normalization can erase dot paths or empty delimiters.
    if (!/^https?:\/\/[^/?#\\\s]+\/?$/i.test(value)) throw new Error()
    url = new URL(value)
    if (url.username || url.password || value.includes("@") || url.pathname !== "/" || url.search || url.hash) throw new Error()
  } catch { throw new ExplicitEndpointError("invalid_origin") }
  const hostname = url.hostname.replace(/^\[|\]$/g, "")
  if (hostname.includes("*") || !hostname) throw new ExplicitEndpointError("invalid_origin")
  return url.origin
}
