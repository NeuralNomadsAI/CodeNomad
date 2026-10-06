// Keep this policy and src-tauri/policy in agreement through tests/urls.json.
// Reject URL-parser repairs before parsing: path normalization can hide /../.
export function canonicalEndpoint(input: string): string {
  if (!/^https:\/\/[\x21-\x7e]+$/i.test(input) || /[\\?#@%]/.test(input)) throw new Error("invalid")
  const remainder = input.slice(8)
  const slash = remainder.indexOf("/")
  if (slash !== -1 && remainder.slice(slash) !== "/") throw new Error("invalid")
  const url = new URL(input)
  const host = url.hostname.toLowerCase()
  if (url.protocol !== "https:" || !host || host.endsWith(".") || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash || host === "localhost" ||
      host.endsWith(".localhost") || host === "tauri" || host === "[::1]" ||
      host === "0.0.0.0" || /^127\./.test(host)) throw new Error("invalid")
  return `${url.origin}/`
}
