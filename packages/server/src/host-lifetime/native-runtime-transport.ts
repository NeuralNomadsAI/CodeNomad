import { createHmac, timingSafeEqual, randomBytes } from "node:crypto"
import type { Duplex } from "node:stream"
import { HostError, MAX_BYTES } from "./protocol"

export const RuntimeOpcode = { member: 1, fatal: 2, stopDrained: 3, serviceStart: 4 } as const
type Opcode = typeof RuntimeOpcode[keyof typeof RuntimeOpcode]
const MAGIC = Buffer.from("CNHRv001")
const HEADER = 62 // magic, scope hash, generation UUID, sequence, opcode, direction
const MAC = 32
/** Fixed private protocol, no generic RPC/exec endpoint. Key and channel are
 * obtained ONLY from native private-peer verification by NativeRuntimeBinding.
 * Bounded pending/output, correlated sequences and write callbacks implement
 * real sustained transport/backpressure, not the native bootstrap byte budget. */
export class RuntimeTransport {
  private buffer = Buffer.alloc(0)
  private next = 1
  private closed = false
  private writes = 0
  private readonly pending = new Map<number, { opcode: Opcode; expires: number; resolve(data: Buffer): void; reject(error: Error): void; timer: NodeJS.Timeout }>()
  private readonly listeners = new Set<() => void>()
  private readonly identity: Buffer
  constructor(private readonly channel: Duplex, private readonly key: Buffer, scopeKey: string, generation: string) {
    if (key.length !== 32 || !/^[a-f0-9]{64}$/.test(scopeKey) || !/^[a-f0-9-]{36}$/.test(generation))
      throw new HostError("invalid-native-channel")
    this.identity = Buffer.concat([MAGIC, Buffer.from(scopeKey, "hex"), Buffer.from(generation.replace(/-/g, ""), "hex")])
    channel.on("data", (chunk: Buffer) => this.receive(Buffer.from(chunk)))
    channel.once("error", () => this.fail())
    channel.once("end", () => this.fail())
    channel.once("close", () => this.fail())
  }
  onLoss(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  get available(): boolean { return !this.closed }
  async request(opcode: Opcode, payload: Buffer, deadline: number): Promise<Buffer> {
    const now = Date.now()
    const expires = Math.min(now + 30_000, deadline)
    const timeout = expires - now
    if (this.closed || !Object.values(RuntimeOpcode).includes(opcode) || payload.length > MAX_BYTES || this.pending.size >= 16
      || this.writes >= 16 || this.next > 0xffffffff || !Number.isSafeInteger(expires) || timeout <= 0)
      throw new HostError("native-runtime-unavailable")
    const id = this.next++
    const header = Buffer.alloc(HEADER)
    this.identity.copy(header); header.writeUInt32LE(id, 56); header[60] = opcode; header[61] = 0
    const content = Buffer.concat([header, payload])
    const signature = createHmac("sha256", this.key).update(content).digest()
    const length = Buffer.alloc(4); length.writeUInt32LE(content.length + MAC)
    const frame = Buffer.concat([length, content, signature])
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new HostError("native-runtime-timeout")); this.fail()
      }, timeout)
      this.pending.set(id, { opcode, expires, resolve, reject, timer })
      this.writes++
      try { this.channel.write(frame, error => { this.writes--; if (error) this.fail() }) }
      catch { this.writes--; this.fail() }
    })
  }
  private receive(chunk: Buffer): void {
    if (this.closed) return
    this.buffer = Buffer.concat([this.buffer, chunk])
    if (this.buffer.length > MAX_BYTES + HEADER + MAC + 4) { this.fail(); return }
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE()
      if (length < HEADER + MAC || length > MAX_BYTES + HEADER + MAC) { this.fail(); return }
      if (this.buffer.length < length + 4) return
      const frame = this.buffer.subarray(4, length + 4); this.buffer = this.buffer.subarray(length + 4)
      const content = frame.subarray(0, -MAC)
      const expected = createHmac("sha256", this.key).update(content).digest()
      if (!timingSafeEqual(frame.subarray(-MAC), expected) || !content.subarray(0, 56).equals(this.identity) || content[61] !== 1) { this.fail(); return }
      const id = content.readUInt32LE(56)
      const pending = this.pending.get(id)
      if (!pending || content[60] !== pending.opcode) { this.fail(); return }
      // A valid MAC/correlation is not admission after absolute expiry, even if
      // the event loop has not run the timer yet. Reject this reply and revoke
      // the channel (including concurrent calls), never publish its payload.
      if (Date.now() >= pending.expires) {
        this.pending.delete(id); clearTimeout(pending.timer)
        pending.reject(new HostError("native-runtime-timeout")); this.fail(); return
      }
      this.pending.delete(id); clearTimeout(pending.timer); pending.resolve(Buffer.from(content.subarray(HEADER)))
    }
  }
  close(): void { this.fail() }
  private fail(): void {
    if (this.closed) return
    this.closed = true; this.key.fill(0)
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new HostError("native-runtime-channel-lost")) }
    this.pending.clear(); this.channel.destroy()
    for (const listener of this.listeners) listener()
    this.listeners.clear()
  }
}
/** Request member receipt body: nonce32 + candidate PID u32. It is not authority;
 * S must query this exact Job and return an attestation verified by native SDK. */
export function memberRequest(pid: number): { nonce: Buffer; bytes: Buffer } {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) throw new HostError("invalid-runtime-member")
  const nonce = randomBytes(32), bytes = Buffer.alloc(36)
  nonce.copy(bytes); bytes.writeUInt32LE(pid, 32)
  return { nonce, bytes }
}
