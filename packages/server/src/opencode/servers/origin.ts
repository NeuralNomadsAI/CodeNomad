import { isIP } from "node:net"

export type EndpointErrorCode = "invalid_origin" | "forbidden_address" | "https_required" | "dns" | "network" | "tls" | "redirect" | "timeout" | "response_limit" | "probe_path" | "custom_ca_unsupported"

/** Diagnostics contain only a stable code, never a URL, credential or upstream error. */
export class ExplicitEndpointError extends Error {
  constructor(readonly code: EndpointErrorCode) { super(code); this.name = "ExplicitEndpointError" }
}

function ipv4(address: string): number[] | undefined {
  if (isIP(address) === 4) return address.split(".").map(Number)
  if (isIP(address) !== 6) return
  const parts = address.split("::")
  const left = parts[0] ? parts[0].split(":") : []
  const right = parts[1] ? parts[1].split(":") : []
  const words = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right].map(word => parseInt(word, 16))
  if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff) {
    return [words[6]! >> 8, words[6]! & 255, words[7]! >> 8, words[7]! & 255]
  }
}

export function admitAddress(input: string): { address: string; family: 4 | 6; loopback: boolean } {
  if (!isIP(input)) throw new ExplicitEndpointError("forbidden_address")
  const address = isIP(input) === 6 ? new URL(`http://[${input}]/`).hostname.slice(1, -1) : input
  const v4 = ipv4(address)
  let loopback = false
  if (v4) {
    const [a, b, c, d] = v4 as [number, number, number, number]
    loopback = a === 127
    if (a === 0 || a >= 224 || (a === 169 && b === 254)
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 168 && b === 63 && c === 129 && d === 16)) throw new ExplicitEndpointError("forbidden_address")
  } else {
    loopback = address === "::1"
    // Global unicast and private ULA only; transition/link-local/site-local ranges fail closed.
    const first = parseInt(address.split(":")[0]!, 16)
    if (!loopback && !((first >= 0x2000 && first <= 0x3fff) || (first >= 0xfc00 && first <= 0xfdff))) {
      throw new ExplicitEndpointError("forbidden_address")
    }
    if (address === "fd00:ec2::254" || address.startsWith("2002:") || address.startsWith("2001:0:") || address.startsWith("2001::")) throw new ExplicitEndpointError("forbidden_address")
  }
  return { address, family: isIP(address) as 4 | 6, loopback }
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
  if (isIP(hostname)) {
    const admitted = admitAddress(hostname)
    if (url.protocol === "http:" && !admitted.loopback) throw new ExplicitEndpointError("https_required")
  } else {
    if (hostname === "*" || hostname.includes("*") || !hostname) throw new ExplicitEndpointError("invalid_origin")
    if (url.protocol === "http:" && hostname !== "localhost") throw new ExplicitEndpointError("https_required")
  }
  return url.origin
}
