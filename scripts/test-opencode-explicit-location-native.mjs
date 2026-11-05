// Fixture-only qualification: native attachment reads plus a synthetic session placement.
// Invoke with an absolute CLI path (or CODENOMAD_FIXTURE_CLI); never discover a shared service.
import assert from "node:assert/strict"
import { mkdir, writeFile, symlink, access, readdir, chmod } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { tsImport } from "tsx/esm/api"
import { withProductRuntime } from "./native-product-fixture.mjs"

const cli = process.argv[2] || process.env.CODENOMAD_FIXTURE_CLI
await withProductRuntime(cli, async () => ({}), async ({ client, root, connection }) => {
  const { ExplicitWorkspace } = await tsImport("../packages/server/src/workspaces/explicit-workspace.ts", import.meta.url)
  const { OpenCodeServerConnections } = await tsImport("../packages/server/src/opencode/servers/connections.ts", import.meta.url)
  const { OpenCodeServerRegistry } = await tsImport("../packages/server/src/opencode/servers/registry.ts", import.meta.url)
  const { OpenCodeServerCredentials } = await tsImport("../packages/server/src/opencode/servers/credentials.ts", import.meta.url)
  const registry = new OpenCodeServerRegistry(() => [{ id: "fixture", kind: "explicit", label: "Fixture", origin: connection.endpoint.url }], () => {})
  const credentials = new OpenCodeServerCredentials({ profileKey: "fixture", configIdentity: root }, registry)
  await credentials.set("fixture", JSON.stringify(connection.endpoint.auth))
  const forbidden = () => { throw new Error("No shared/local service access") }
  const connections = new OpenCodeServerConnections({ registry, credentials, local: { acquire: forbidden, existing: forbidden, invalidate: forbidden } })
  const existing = path.join(root, "existing")
  const absent = path.join(root, "absent")
  const alias = path.join(root, "alias")
  const inaccessible = path.join(root, "inaccessible")
  await mkdir(existing)
  await writeFile(path.join(existing, "proof.txt"), "fixture-only\n")
  await symlink(existing, alias, process.platform === "win32" ? "junction" : "dir")
  await mkdir(inaccessible)
  let restoreAccess
  if (process.platform === "win32") {
    const user = execFileSync("whoami", [], { encoding: "utf8", windowsHide: true }).trim()
    execFileSync("icacls", [inaccessible, "/deny", `${user}:(RD)`], { windowsHide: true })
    restoreAccess = () => execFileSync("icacls", [inaccessible, "/remove:d", user], { windowsHide: true })
  } else {
    await chmod(inaccessible, 0)
    restoreAccess = () => chmod(inaccessible, 0o700)
  }
  const evidence = { version: (await client.server.info()).version, paths: {} }
  try {
    try { await readdir(inaccessible) }
    catch { evidence.inaccessibleEnforced = true }
    assert(evidence.inaccessibleEnforced, "Run this qualification as a user subject to directory read permissions")
    for (const [name, directory] of Object.entries({ existing, absent, alias, inaccessible })) {
      const result = {}
      for (const [operation, run] of Object.entries({
        location: () => client.location.get({ location: { directory } }),
        list: () => client.file.list({ location: { directory }, path: "." }),
      })) {
        try { result[operation] = { accepted: true, value: await run() } }
        catch (error) { result[operation] = { accepted: false, tag: error._tag, message: error.message } }
      }
      const owner = new ExplicitWorkspace(connections, { serverId: "fixture", directory })
      try {
        await owner.validate(new AbortController().signal)
        result.attachment = { accepted: true }
      } catch (error) { result.attachment = { accepted: false, code: error.code } }
      finally { owner.release() }
      evidence.paths[name] = result
    }
    await assert.rejects(access(absent), { code: "ENOENT" })
    const session = await client.session.create({ location: { directory: alias } })
    const placed = await client.session.get({ sessionID: session.id })
    assert.equal(placed.location.directory, alias)
    evidence.sessionPlacement = placed.location
    assert.equal(evidence.paths.existing.location.accepted, true)
    assert.equal(evidence.paths.existing.list.accepted, true)
    assert.equal(evidence.paths.existing.attachment.accepted, true)
    assert.equal(evidence.paths.alias.attachment.accepted, true)
    assert.equal(evidence.paths.absent.location.accepted && evidence.paths.absent.list.accepted, false,
      "Explicit attachment requires a native distinction between an existing and absent directory")
    assert.equal(evidence.paths.inaccessible.location.accepted && evidence.paths.inaccessible.list.accepted, false,
      "Explicit attachment must reject an unreadable directory")
    assert.equal(evidence.paths.absent.attachment.accepted, false)
    assert.equal(evidence.paths.inaccessible.attachment.accepted, false)
    assert.equal(connections.activeExplicitTargets, 0)
  } finally {
    try {
      await writeFile(path.join(root, "explicit-location-evidence.json"), JSON.stringify(evidence, null, 2))
      console.log(JSON.stringify(evidence, null, 2))
    } finally { await restoreAccess(); await connections.dispose() }
  }
})
