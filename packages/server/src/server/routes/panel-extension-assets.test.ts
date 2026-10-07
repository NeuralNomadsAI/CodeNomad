import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import Fastify from "fastify"
import { PanelExtensionStore } from "../../panel-extensions/store"
import { readPanelExtensionArchive } from "../../panel-extensions/archive"
import { fixtureArchive } from "../../panel-extensions/archive-fixture"
import { registerPanelExtensionAssetRoutes } from "./panel-extension-assets"

test("asset routes require explicit API2 consent, exact digest and owned session, and fence revocation/moves across RPC", async () => {
  const directory=await mkdtemp(path.join(os.tmpdir(),"opencode-assets-route-")), app=Fastify(), store=new PanelExtensionStore(directory)
  const pkg=await readPanelExtensionArchive(fixtureArchive("<p>Assets</p>",{apiVersion:2,permissions:["session.context","session.assets.read"]}))
  let calls=0, owned=true, revoke=false, move=false, directoryNow="/repo", output:unknown={status:"page",entries:[],cursor:null}
  const client={session:{get:async()=>({location:{directory:directoryNow}})},rpc:{call:async()=>{calls++;if(revoke)await store.activate(pkg.manifest.id,pkg.digest,false);if(move)directoryNow="/moved";return{output}}}}
  registerPanelExtensionAssetRoutes(app,{store,workspaceManager:{getSharedServiceClient:async()=>client as any,ownsLocation:async()=>owned}})
  const body={instanceId:"i",digest:pkg.digest,sessionID:"s"}
  const send=(extra={})=>app.inject({method:"POST",url:`/api/panel-extensions/${pkg.manifest.id}/assets`,payload:{...body,...extra}})
  try {
    await store.install(pkg)
    assert.equal((await send()).statusCode,403);assert.equal(calls,0)
    await store.activate(pkg.manifest.id,pkg.digest,true)
    assert.equal((await send({directory:"/other"})).statusCode,400)
    assert.equal((await send({digest:"a".repeat(64)})).statusCode,409)
    owned=false;assert.equal((await send()).statusCode,403);assert.equal(calls,0);owned=true
    const success=await send();assert.equal(success.statusCode,200);assert.equal(success.headers["cache-control"],"no-store")
    revoke=true;assert.equal((await send()).statusCode,403);revoke=false
    await store.activate(pkg.manifest.id,pkg.digest,true)
    move=true;assert.equal((await send()).statusCode,409);move=false
    output={status:"page",entries:[{private:"secret"}],cursor:null};assert.equal((await send()).statusCode,503)
    const legacy=await readPanelExtensionArchive(fixtureArchive("<p>Context only</p>"))
    await store.install(legacy,pkg.digest);await store.activate(legacy.manifest.id,legacy.digest,true)
    assert.equal((await send({digest:legacy.digest})).statusCode,403)
  } finally {await app.close();await rm(directory,{recursive:true,force:true})}
})

test("final session/ownership reads cannot return asset bytes after disable, replacement or removal", async () => {
  for (const boundary of ["session", "ownership"] as const) for (const mutation of ["disable", "replace", "remove"] as const) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-assets-revoke-")), app = Fastify(), store = new PanelExtensionStore(directory)
    const pkg = await readPanelExtensionArchive(fixtureArchive("<p>Assets</p>", { apiVersion: 2, permissions: ["session.context", "session.assets.read"] }))
    let sessions = 0, ownership = 0, release!: () => void, started!: () => void
    const admitted = new Promise<void>(resolve => { started = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const client = { session: { get: async () => {
      if (++sessions === 2 && boundary === "session") { started(); await held }
      return { location: { directory: "/repo" } }
    } }, rpc: { call: async () => ({ output: { status: "asset", mime: "text/plain", uri: "data:text/plain;base64,c2VjcmV0" } }) } }
    registerPanelExtensionAssetRoutes(app, { store, workspaceManager: { getSharedServiceClient: async () => client as any, ownsLocation: async () => {
      if (++ownership === 2 && boundary === "ownership") { started(); await held }
      return true
    } } })
    try {
      await store.install(pkg); await store.activate(pkg.manifest.id, pkg.digest, true)
      const response = app.inject({ method: "POST", url: `/api/panel-extensions/${pkg.manifest.id}/assetRead`, payload: {
        instanceId: "i", digest: pkg.digest, sessionID: "s", target: { messageID: "m", part: 0, index: 0, digest: "a".repeat(64) },
      } }).then(value => value)
      await admitted
      if (mutation === "disable") await store.activate(pkg.manifest.id, pkg.digest, false)
      else if (mutation === "remove") await store.remove(pkg.manifest.id, pkg.digest)
      else await store.install(await readPanelExtensionArchive(fixtureArchive("<p>Replacement</p>")), pkg.digest)
      release()
      const result = await response
      assert.equal(result.statusCode, { disable: 403, replace: 409, remove: 404 }[mutation], `${boundary}: ${mutation}`)
      assert.equal(result.body.includes("c2VjcmV0"), false)
    } finally { release(); await app.close(); await rm(directory, { recursive: true, force: true }) }
  }
})
