// PRIVATE contained manager. Owner stdio is binary control, NOT auth/Node IPC.
import { BackendHarness, exerciseProtocol } from "./protocol-suite"

const deadline = setTimeout(() => process.exit(1), 40_000)
let buffer = Buffer.alloc(0), bootstrapped = false, next = 1
let start!: () => void
const started = new Promise<void>(resolve => { start = resolve })
const pending = new Map<number, { opcode: number; resolve(data: Buffer): void; reject(): void; timer: NodeJS.Timeout }>()
function frame(opcode: number, id: number, payload: Buffer) {
  const bytes = Buffer.alloc(9 + payload.length)
  bytes.writeUInt32LE(5 + payload.length); bytes[4] = opcode; bytes.writeUInt32LE(id, 5)
  payload.copy(bytes, 9); return bytes
}
function request(opcode: number, payload = Buffer.alloc(0)) {
  if (pending.size >= 8 || payload.length > 512 || next > 32) throw new Error("owner-budget")
  const id = next++
  return new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("owner-timeout")) }, 4000)
    pending.set(id, { opcode, resolve, reject() { reject(new Error("owner-closed")) }, timer })
    process.stdout.write(frame(opcode, id, payload))
  })
}
const pidBytes = (pid: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(pid); return b }
process.stdin.on("data", data => {
  buffer = Buffer.concat([buffer, data])
  if (buffer.length > 4096) process.exit(1)
  if (!bootstrapped) {
    if (buffer.length < 64) return
    const proof = buffer.subarray(0, 64); buffer = buffer.subarray(64)
    if (proof.subarray(0, 8).toString() !== "CNHLv001" || proof.readUInt32LE(40) !== process.pid
      || proof.readUInt32LE(52) !== process.ppid) process.exit(1)
    process.stdout.write(proof); bootstrapped = true
  }
  while (buffer.length >= 4) {
    const size = buffer.readUInt32LE()
    if (size < 5 || size > 1024) process.exit(1)
    if (buffer.length < 4 + size) return
    const packet = buffer.subarray(4, 4 + size); buffer = buffer.subarray(4 + size)
    const opcode = packet[0], id = packet.readUInt32LE(1)
    if (opcode === 0 && id === 0 && packet.length === 5) { start(); continue }
    const receipt = pending.get(id)
    if (!receipt || opcode !== (receipt.opcode | 128)) process.exit(1)
    pending.delete(id); clearTimeout(receipt.timer); receipt.resolve(packet.subarray(5))
  }
})
process.stdin.once("end", () => process.exit(1))
process.stdin.once("error", () => process.exit(1))
async function main() {
  await started // S has assigned, resumed, challenged and revalidated this exact M.
  const harness = new BackendHarness(process.argv[2], async pid => {
    const identity = await request(1, pidBytes(pid))
    if (identity.length !== 12 || identity.readUInt32LE() !== pid) throw new Error("owner-member")
    // FILETIME remains exact binary u64. JS numbers/claimed identities grant nothing.
    return { pid, creationFiletime: identity.readBigUInt64LE(4).toString() }
  })
  await exerciseProtocol(harness) // Auth/IPC/shutdown flows while all B's inherit Job.
  const survivor = harness.start(); await harness.ready(survivor)
  const descendant = await harness.request(survivor, "descendant") as { pid: number }
  await request(2, pidBytes(descendant.pid))
  await request(3) // Fixed S-owned external Node sentinel; no exec/path/args payload.
  await request(4) // Protocol completion observation, never native ownership authority.
  clearTimeout(deadline)
  process.exit(77) // Deliberate manager death. Do NOT stop survivor/descendant ourselves.
}
main().catch(() => process.exit(1)) // Static exit only; no raw auth/IPC payload output.
