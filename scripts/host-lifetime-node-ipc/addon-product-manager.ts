// Exact production factory must refuse a real, but unqualified, compiled session.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { NativeRuntimeBinding } from "../../packages/server/src/host-lifetime/native-runtime-binding"
import { NativeRuntimeCapability } from "../../packages/server/src/host-lifetime/native-runtime"
const timer = setTimeout(() => process.exit(1), 10_000)
async function main() {
  const file = fileURLToPath(new URL("../../packages/native-host-lifetime/target/debug/codenomad_native_host_lifetime.node", import.meta.url))
  const digest = createHash("sha256").update(await readFile(file)).digest("hex")
  const binding = await NativeRuntimeBinding.load(file, digest)
  assert.equal(binding.production, true)
  await assert.rejects(NativeRuntimeCapability.open(binding), { code: "native-runtime-qualification-failed" })
  clearTimeout(timer); process.exit(0)
}
main().catch(() => process.exit(1))
