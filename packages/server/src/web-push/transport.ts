import { ECDH } from "node:crypto"
import dns from "node:dns"
import https from "node:https"
import { BlockList, isIP, type LookupFunction } from "node:net"
import { generateRequestDetails, generateVAPIDKeys } from "web-push"
import { normalizeNetworkHost } from "../server/network-host"

export type PushSubscription = { endpoint: string; keys: { p256dh: string; auth: string } }
export type VapidKeys = { publicKey: string; privateKey: string; subject?: string }
export type PushResult = { status: number; retryAfterMs?: number }
type Destination = { address: string; family: 4 | 6; port?: number }
type Dependencies = {
  /** Trusted destination authority; fixtures may explicitly select their local listener. */
  resolve?: (hostname: string, signal: AbortSignal) => Promise<Destination>
  ca?: string | Buffer
  timeoutMs?: number
}

const hosts = new Set(["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"])
const defaultSubject = "https://github.com/NeuralNomadsAI/CodeNomad"
const denied = new BlockList()
for (const [ip, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const) denied.addSubnet(ip, prefix, "ipv4")
// IPv6 destinations must be global unicast; refuse transition/documentation ranges too.
const globalV6 = new BlockList()
globalV6.addSubnet("2000::", 3, "ipv6")
for (const [ip, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) {
  denied.addSubnet(ip, prefix, "ipv6")
}

function key(input: unknown, length: number): Buffer {
  if (typeof input !== "string" || input.length !== Math.ceil(length * 4 / 3)
    || !/^[A-Za-z0-9_-]+$/.test(input)) throw new Error("Invalid push subscription key")
  const bytes = Buffer.from(input, "base64url")
  if (bytes.length !== length || bytes.toString("base64url") !== input) throw new Error("Invalid push subscription key")
  return bytes
}

export function validateSubscription(input: unknown): PushSubscription {
  if (!input || typeof input !== "object") throw new Error("Invalid push subscription")
  const value = input as Partial<PushSubscription>
  if (typeof value.endpoint !== "string" || value.endpoint.length > 4096
    || value.endpoint.includes("#") || /[\s\\]/.test(value.endpoint)
    || /^https:\/\/[^/?#]*@/i.test(value.endpoint)) throw new Error("Invalid push endpoint")
  let url: URL
  try { url = new URL(value.endpoint) } catch { throw new Error("Invalid push endpoint") }
  if (url.protocol !== "https:" || url.username || url.password || url.port || !hosts.has(url.hostname)) {
    throw new Error("Invalid push endpoint")
  }
  if (!value.keys || typeof value.keys !== "object") throw new Error("Invalid push subscription keys")
  const publicKey = key(value.keys.p256dh, 65)
  key(value.keys.auth, 16)
  try {
    if (publicKey[0] !== 4) throw new Error()
    ECDH.convertKey(publicKey, "prime256v1")
  } catch { throw new Error("Invalid push subscription public key") }
  return { endpoint: url.href, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } }
}

export function generateKeys(): VapidKeys { return generateVAPIDKeys() }

export function validateSubject(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error("Invalid VAPID subject") }
  if (value.length > 2048 || value.includes("#") || /[\s\\]/.test(value) || url.username || url.password
    || /^https:\/\/[^/?#]*@/i.test(value)
    || (url.protocol === "https:" ? !url.hostname
      : url.protocol !== "mailto:" || !/^[^@/?]+@[^@/?]+$/.test(url.pathname) || Boolean(url.search))) {
    throw new Error("Invalid VAPID subject")
  }
  return value
}

async function resolvePublic(hostname: string): Promise<Destination> {
  // lookup follows OS DNS aliases. Check every answer, then pin one without a second lookup.
  const addresses = await dns.promises.lookup(hostname, { all: true })
  if (!addresses.length) throw new Error("Push destination has no addresses")
  for (const entry of addresses) {
    const address = normalizeNetworkHost(entry.address)
    const family = isIP(address)
    if (!family || (family === 4 ? denied.check(address, "ipv4")
      : !globalV6.check(address, "ipv6") || denied.check(address, "ipv6"))) {
      throw new Error("Push destination must be public")
    }
  }
  const first = addresses[0]
  return { address: first.address, family: first.family as 4 | 6 }
}

function retryAfter(value: string | undefined): number | undefined {
  if (!value || value.length > 128) return
  const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now()
  return Number.isFinite(ms) ? Math.max(0, Math.min(ms, 86_400_000)) : undefined
}

export function createPushTransport(deps: Dependencies = {}) {
  const timeoutMs = deps.timeoutMs ?? 10_000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("Invalid push timeout")
  return {
    async send(input: PushSubscription, payload: string, vapid: VapidKeys, caller?: AbortSignal): Promise<PushResult> {
      const subscription = validateSubscription(input)
      if (typeof payload !== "string" || Buffer.byteLength(payload) > 3993) throw new Error("Push payload is too large")
      const subject = validateSubject(vapid.subject ?? defaultSubject)
      const controller = new AbortController()
      const signal = caller ? AbortSignal.any([caller, controller.signal]) : controller.signal
      const timer = setTimeout(() => controller.abort(new Error("Push timeout")), timeoutMs)
      let abort: () => void = () => {}
      try {
        signal.throwIfAborted()
        const aborted = new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason)
          signal.addEventListener("abort", abort, { once: true })
        })
        const exchange = async (): Promise<PushResult> => {
          const url = new URL(subscription.endpoint)
          const destination = await (deps.resolve ?? resolvePublic)(url.hostname, signal)
          signal.throwIfAborted()
          // Buffer preserves encryption even for the empty string.
          const details = generateRequestDetails(subscription, Buffer.from(payload), {
            contentEncoding: "aes128gcm", TTL: 300, vapidDetails: { ...vapid, subject },
          })
          const lookup: LookupFunction = (_host, options, callback) => options.all
            ? callback(null, [{ address: destination.address, family: destination.family }])
            : callback(null, destination.address, destination.family)
          return new Promise((resolve, reject) => {
            const request = https.request(url, {
              method: "POST", headers: { ...details.headers, Host: url.host }, signal,
              port: destination.port ?? 443, lookup, family: destination.family,
              servername: url.hostname, ca: deps.ca, rejectUnauthorized: true, agent: false,
              maxHeaderSize: 8192,
            }, response => {
              const retryAfterMs = retryAfter(response.headers["retry-after"])
              const result = { status: response.statusCode ?? 0, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }
              // The service body is irrelevant. Close immediately, bounding response memory and duration.
              response.destroy()
              resolve(result)
            })
            request.on("error", reject)
            request.end(details.body)
          })
        }
        return await Promise.race([exchange(), aborted])
      } finally {
        clearTimeout(timer)
        signal.removeEventListener("abort", abort)
      }
    },
  }
}

export const { send } = createPushTransport()
