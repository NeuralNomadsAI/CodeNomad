export const NATIVE_BOOTSTRAP_REQUEST_PREFIX = "CODENOMAD_BOOTSTRAP_REQUEST:"
export const NATIVE_BOOTSTRAP_REPLY_PREFIX = "CODENOMAD_BOOTSTRAP_REPLY:"

// Trusted parent pipe only, never a HTTP or model-visible endpoint. The manager
// must redact these lines and keep proofs out of its persistent registry/logs.
export class NativeBootstrap {
  constructor(
    private readonly enabled: boolean,
    private readonly issue: () => string | null,
    private readonly output: Pick<NodeJS.WriteStream, "write">,
  ) {}

  handleLine(line: string): boolean {
    if (!line.startsWith(NATIVE_BOOTSTRAP_REQUEST_PREFIX)) return false
    if (!this.enabled || line.length > 1024) return true
    let request: unknown
    try { request = JSON.parse(line.slice(NATIVE_BOOTSTRAP_REQUEST_PREFIX.length)) } catch { return true }
    if (!request || typeof request !== "object" || Array.isArray(request)) return true
    const value = request as Record<string, unknown>
    if (value.v !== 1 || typeof value.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.id)
      || Object.keys(value).some(key => key !== "v" && key !== "id")) return true
    let token: string | null = null
    try { token = this.issue() } catch { /* Return only a fixed, redacted failure. */ }
    this.output.write(`${NATIVE_BOOTSTRAP_REPLY_PREFIX}${JSON.stringify({ v: 1, id: value.id,
      ...(token ? { ok: true, token } : { ok: false, error: "bootstrap-unavailable" }) })}\n`)
    return true
  }
}
