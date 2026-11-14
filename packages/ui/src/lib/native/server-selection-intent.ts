export type ServerSelectionIntent = Readonly<{ id: string; baseUrl: string; skipTlsVerify: boolean; ssh?: Readonly<{ host: string }> }>

/** Only saved target policy crosses the host bridge; credentials stay in the backend. */
export function normalizeServerSelection(value: unknown): ServerSelectionIntent | undefined {
  if (!value || typeof value !== "object") return
  const p = value as Record<string, unknown>
  if (Object.keys(p).some(key => !["id", "baseUrl", "skipTlsVerify", "ssh"].includes(key))
    || typeof p.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(p.id) || p.id === "local" || typeof p.baseUrl !== "string" || p.baseUrl.length > 4096
    || typeof p.skipTlsVerify !== "boolean") return
  try {
    const url = new URL(p.baseUrl)
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return
  } catch { return }
  const ssh = p.ssh as { host?: unknown } | undefined
  if (p.ssh !== undefined && (!ssh || Object.keys(ssh).some(key => key !== "host") || typeof ssh.host !== "string"
    || !ssh.host || ssh.host.length > 256 || /[\s\x00-\x1f]/.test(ssh.host))) return
  return Object.freeze({ id: p.id, baseUrl: p.baseUrl, skipTlsVerify: p.skipTlsVerify,
    ...(ssh ? { ssh: Object.freeze({ host: ssh.host as string }) } : {}) })
}
