const PRODUCT_TITLE = "CodeNomad"

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  return host === "localhost" || host.endsWith(".localhost") || host === "::1"
    || /^127(\.\d{1,3}){3}$/.test(host) || /^::ffff:127(\.\d{1,3}){3}$/.test(host)
    // URL parsing serializes an IPv4-mapped loopback as ::ffff:7fxx:xxxx.
    || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host)
}

/**
 * The browser tab title of the web client: the serving host (with its port only when it is not
 * the scheme's default) so tabs of several servers differ, or the product name on loopback.
 */
export function webTabTitle(location: Pick<Location, "host" | "hostname">): string {
  if (!location.hostname || isLoopbackHostname(location.hostname)) return PRODUCT_TITLE
  return `${location.host} — ${PRODUCT_TITLE}`
}
