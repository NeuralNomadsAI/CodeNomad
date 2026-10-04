import { hex } from "./channel-codec.mjs"
export async function consumeBootstrap({ expectedProfile, expectedGeneration, role = "manager", signal } = {}) {
  // This is the ONLY key/locator ingestion. No argv/environment/file fallback.
  const input = process.stdin
  let buffer = Buffer.alloc(0), challenge
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("native-bootstrap-deadline")), 5000)
    const abort = () => finish(new Error("native-bootstrap-cancelled"))
    const ended = () => finish(new Error("native-bootstrap-closed"))
    function finish(error, boot) {
      clearTimeout(timer); input.off("data", data); input.off("end", ended); input.off("error", ended)
      signal?.removeEventListener("abort", abort); input.pause(); buffer = Buffer.alloc(0)
      error ? reject(error) : resolve(boot)
    }
    function data(chunk) {
      try {
        buffer = Buffer.concat([buffer, chunk])
        if (buffer.length > 8192) throw new Error("native-bootstrap-bound")
        if (!challenge) {
          if (buffer.length < 64) return
          challenge = Buffer.from(buffer.subarray(0, 64)); buffer = buffer.subarray(64)
          if (challenge.subarray(0, 8).toString() !== "CNHLv001" || challenge.readUInt32LE(40) !== process.pid
            || challenge.readUInt32LE(52) !== process.ppid) throw new Error("native-bootstrap-identity")
          process.stdout.write(challenge)
        }
        if (buffer.length < 4) return
        const size = buffer.readUInt32LE()
        if (!size || size > 4000) throw new Error("native-bootstrap-bound")
        if (buffer.length < 4 + size) return
        if (buffer.length !== 4 + size) throw new Error("native-bootstrap-trailing-data")
        const boot = JSON.parse(buffer.subarray(4).toString())
        if (boot.v !== 1 || boot.role !== role || !hex(boot.secret) || !hex(boot.profile)
          || !/^[a-f0-9-]{36}$/.test(boot.generation) || (expectedProfile && boot.profile !== expectedProfile)
          || (expectedGeneration && boot.generation !== expectedGeneration)
          || !/^\\\\\.\\pipe\\codenomad-runtime-v1-[a-f0-9]{64}$/.test(boot.pipe)
          || boot.peer?.pid !== process.pid || boot.supervisor?.pid !== process.ppid
          || boot.peer.creationFiletime !== challenge.readBigUInt64LE(44).toString()
          || boot.supervisor.creationFiletime !== challenge.readBigUInt64LE(56).toString()) throw new Error("native-bootstrap-identity")
        finish(undefined, boot)
      } catch { finish(new Error("native-bootstrap-invalid")) }
    }
    if (signal?.aborted) { abort(); return }
    signal?.addEventListener("abort", abort, { once: true })
    input.on("data", data); input.once("end", ended); input.once("error", ended); input.resume()
  })
}
