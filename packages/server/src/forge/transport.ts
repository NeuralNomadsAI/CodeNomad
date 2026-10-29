import { execFile } from "node:child_process"

export const FORGE_TIMEOUT_MS = 15_000
const MAX_BODY_BYTES = 4 * 1024 * 1024

/** One HTTP exchange with a forge API, by CLI or anonymously. */
export interface ForgeResponse {
  status: number
  headers: Map<string, string>
  body: string
}

/** A forge API reachable at relative paths (`repos/o/r/issues?...`). */
export interface ForgeTransport {
  access: "cli" | "anonymous"
  request(path: string): Promise<ForgeResponse>
}

export type ProcessResult = { stdout: string; stderr: string; code: number | string | null }
export type ProcessRunner = (command: string, args: string[]) => Promise<ProcessResult>

// No prompts, pagers, colours, update checks or telemetry: the output is parsed.
const QUIET_ENV = {
  GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_PAGER: "", GH_TELEMETRY: "0",
  GLAB_NO_PROMPT: "1", GLAB_CHECK_UPDATE: "false", GLAB_SHOW_WHATS_NEW: "false", GLAB_NOTIFY_SKILL_UPDATES: "false",
  GLAB_SEND_TELEMETRY: "0", GLAB_PAGER: "", GLAB_COLOR: "never", NO_COLOR: "1",
}

export const runProcess: ProcessRunner = (command, args) => new Promise(resolve => {
  execFile(command, args, {
    windowsHide: true, timeout: FORGE_TIMEOUT_MS, maxBuffer: MAX_BODY_BYTES, env: { ...process.env, ...QUIET_ENV },
  }, (error, stdout, stderr) => resolve({ stdout, stderr, code: error ? (error as NodeJS.ErrnoException).code ?? 1 : 0 }))
})

/** Splits `HTTP/x NNN reason`, header lines, a blank line and the body, as `gh api -i` and `glab api -i` print them. */
export function parseIncludedResponse(output: string): ForgeResponse | undefined {
  const match = /^HTTP\/[\d.]+ (\d{3})[^\r\n]*\r?\n([\s\S]*?)\r?\n\r?\n([\s\S]*)$/.exec(output)
  if (!match) return undefined
  return { status: Number(match[1]), headers: parseHeaders(match[2]!), body: match[3]! }
}

function parseHeaders(text: string): Map<string, string> {
  const headers = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf(":")
    if (separator > 0) headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim())
  }
  return headers
}

export class ForgeCliUnavailable extends Error {}

/** `gh api` and `glab api`: authenticated with the user's sign-in for `host`. */
export function includedCliTransport(command: "gh" | "glab", host: string, run: ProcessRunner = runProcess): ForgeTransport {
  return {
    access: "cli",
    async request(path) {
      const result = await run(command, ["api", "--hostname", host, "-i", path])
      // Not installed, or (gh) not signed in to this host: the caller falls back to anonymous access.
      if (result.code === "ENOENT" || (command === "gh" && result.code === 4)) throw new ForgeCliUnavailable(command)
      const response = parseIncludedResponse(result.stdout)
      if (!response) throw new Error(result.stderr.trim() || `${command} api failed (${result.code})`)
      return response
    },
  }
}

/** `tea api` prints the status and headers on stderr and exits 0 even on HTTP errors. */
export function teaTransport(login: string, run: ProcessRunner = runProcess): ForgeTransport {
  return {
    access: "cli",
    async request(path) {
      const result = await run("tea", ["api", "--login", login, "-i", `/${path}`])
      if (result.code === "ENOENT") throw new ForgeCliUnavailable("tea")
      const status = /HTTP\/[\d.]+ (\d{3})/.exec(result.stderr)
      if (result.code !== 0 || !status) throw new Error(result.stderr.trim() || `tea api failed (${result.code})`)
      const headerText = result.stderr.slice(result.stderr.indexOf(status[0]) + status[0].length)
      return { status: Number(status[1]), headers: parseHeaders(headerText), body: result.stdout }
    },
  }
}

/** The tea login configured for `host`, if any (`tea logins list -o json`). */
export async function findTeaLogin(host: string, run: ProcessRunner = runProcess): Promise<string | undefined> {
  const result = await run("tea", ["logins", "list", "-o", "json"])
  if (result.code !== 0) return undefined
  try {
    const logins = JSON.parse(result.stdout) as Array<{ name?: string; url?: string }>
    return logins.find(login => login.url && new URL(login.url).hostname.toLowerCase() === host)?.name
  } catch {
    return undefined
  }
}

/** Public REST access without credentials: public repositories only, with low rate limits. */
export function anonymousTransport(base: string, fetcher: typeof fetch = fetch): ForgeTransport {
  return {
    access: "anonymous",
    async request(path) {
      const response = await fetcher(`${base}${path}`, {
        headers: { Accept: "application/json", "User-Agent": "CodeNomad" },
        redirect: "error",
        signal: AbortSignal.timeout(FORGE_TIMEOUT_MS),
      })
      const headers = new Map<string, string>()
      response.headers.forEach((value, key) => headers.set(key.toLowerCase(), value))
      const body = await response.text()
      if (body.length > MAX_BODY_BYTES) throw new Error("Forge response too large")
      return { status: response.status, headers, body }
    },
  }
}

/** Uses the CLI while it is available, otherwise the anonymous API, remembering the choice. */
export function preferCli(cli: ForgeTransport | undefined, anonymous: ForgeTransport): ForgeTransport {
  let current = cli ?? anonymous
  return {
    get access() { return current.access },
    async request(path) {
      if (current === anonymous) return anonymous.request(path)
      try {
        return await current.request(path)
      } catch (error) {
        if (!(error instanceof ForgeCliUnavailable)) throw error
        current = anonymous
        return anonymous.request(path)
      }
    },
  }
}
