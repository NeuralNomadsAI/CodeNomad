// Deliberately invalid peer replies, but actual compiled SDK/private native peer.
import { createRequire } from "node:module"
import { randomBytes, createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { framed, write } from "../../packages/native-host-lifetime/node/channel-codec.mjs"
export async function runFaultPeer(file, digest, fault) {
  if (!["malformed-peer", "unknown-peer-id", "unconfirmed-failure", "wrong-peer-scope", "oversize-output"].includes(fault) || createHash("sha256").update(await readFile(file)).digest("hex") !== digest) throw new Error("native-fixture-binding-refused")
  const sdk = createRequire(import.meta.url)(file)
  if (sdk.abi !== "codenomad.runtime.v1") throw new Error("native-fixture-binding-refused")
  const opened = await sdk.openServicePeer(randomBytes(32))
  opened.channel.on("error", () => { sdk.release(opened.nativeSession); process.exit(0) })
  opened.channel.on("close", () => { sdk.release(opened.nativeSession); process.exit(0) })
  const timer = setTimeout(() => process.exit(1), 15000)
  framed(opened.channel, value => {
    const reply = { v: 1, id: fault === "unknown-peer-id" ? value.id + 100000 : value.id,
      profile: opened.application.profile, generation: opened.application.generation, error: "native-service-failed",
      ...(fault === "malformed-peer" ? { result: {} } : {}) }
    if (fault === "wrong-peer-scope") reply.profile = "0".repeat(64)
    if (fault === "oversize-output") {
      delete reply.error
      reply.result = { receipt: "0".repeat(64), output: { stdout: "x".repeat(65537), stderr: "" } }
    }
    void write(opened.channel, reply).catch(() => process.exit(1))
  }, () => { clearTimeout(timer); process.exit(1) })
}
