import { createHmac, timingSafeEqual } from "node:crypto"
export const MAX_FRAME = 256 * 1024, MAX_PENDING = 16, MAX_QUEUE = 1024 * 1024
export function encode(value) {
  const bytes = Buffer.from(JSON.stringify(value))
  if (!bytes.length || bytes.length > MAX_FRAME) throw new Error("native-channel-frame-bound")
  const frame = Buffer.alloc(4 + bytes.length); frame.writeUInt32LE(bytes.length); bytes.copy(frame, 4)
  return frame
}
export function proof(boot, challenge, domain) {
  const text = ["codenomad-runtime-v1", boot.profile, boot.generation, boot.role,
    boot.peer.pid, boot.peer.creationFiletime, boot.supervisor.pid, boot.supervisor.creationFiletime,
    challenge, domain].join("\n")
  return createHmac("sha256", Buffer.from(boot.secret, "hex")).update(text).digest("hex")
}
export const hex = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
export function equal(a, b) { return hex(a) && hex(b) && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex")) }
export function framed(socket, receive, fail) {
  let buffer = Buffer.alloc(0), partialTimer
  socket.on("data", chunk => {
    try {
      if (buffer.length + chunk.length > MAX_FRAME + 65536) throw new Error("native-channel-frame-bound")
      buffer = Buffer.concat([buffer, chunk])
      let frames = 0
      while (buffer.length >= 4) {
        const size = buffer.readUInt32LE()
        if (!size || size > MAX_FRAME || ++frames > 64) throw new Error("native-channel-frame-bound")
        if (buffer.length < size + 4) break
        const value = JSON.parse(buffer.subarray(4, size + 4).toString())
        buffer = buffer.subarray(size + 4); receive(value)
      }
      if (!buffer.length) { clearTimeout(partialTimer); partialTimer = undefined }
      else if (!partialTimer) partialTimer = setTimeout(() => fail(new Error("native-channel-partial-deadline")), 5000)
    } catch { fail(new Error("native-channel-invalid")) }
  })
  socket.once("close", () => { clearTimeout(partialTimer); buffer = Buffer.alloc(0) })
}
export async function write(socket, value) {
  const bytes = encode(value)
  if (socket.destroyed || socket.writableLength + bytes.length > MAX_QUEUE) throw new Error("native-channel-backpressure")
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("native-channel-write-deadline")), 5000)
    const closed = () => finish(new Error("native-channel-closed"))
    const finish = error => { clearTimeout(timer); socket.off("close", closed); error ? reject(error) : resolve() }
    socket.once("close", closed)
    socket.write(bytes, error => finish(error ? new Error("native-channel-write-failed") : undefined))
  })
}
