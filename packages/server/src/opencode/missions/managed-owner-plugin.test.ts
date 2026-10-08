import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { MANAGED_OWNER_RPC_ID } from "./managed-owner-plugin"

test("packaged Missions entry carries the owned namespace issuer and native observer", async () => {
  const script = await readFile(new URL("../../../scripts/build-missions-plugin.mjs", import.meta.url), "utf8")
  assert.match(script, /missions\/managed-owner-plugin\.ts/)
  const output = await build({ entryPoints: [fileURLToPath(new URL("./managed-owner-plugin.ts", import.meta.url))],
    bundle: true, write: false, platform: "node", format: "esm", target: "node22" })
  const code = output.outputFiles[0]!.text
  assert.ok(code.includes(MANAGED_OWNER_RPC_ID))
  assert.ok(code.includes("missions.observeNativeManagedOwner"))
  assert.ok(code.includes("new NativeMissionAuthorityStore"))
  assert.ok(code.includes("register(MANAGED_OWNER_RPC"))
})
