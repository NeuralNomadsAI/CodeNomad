// Qualification-only fresh-RPC probe. It never patches production sources or
// bundles; journal writes are refused if acquisition reaches that boundary.
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { build } from "esbuild"
import { nativePluginBuild } from "../packages/server/scripts/native-plugin-build.mjs"

export async function buildStopDiagnosticPlugin(root) {
  const directory = path.join(root, "stop-diagnostic"), entry = path.join(directory, "entry.mjs")
  await mkdir(directory)
  const source = name => fileURLToPath(new URL(`../packages/server/src/${name}.ts`, import.meta.url))
  const imports = { actors: source("opencode/missions/native-mission-schedule-actors"),
    invocation: source("opencode/missions/native-invocation"), binding: source("opencode/missions/native-schedule-carrier-binding"),
    identity: source("opencode/missions/native-schedule-transport-identity"), placement: source("missions/mission-calendar-placement"), document: source("missions/mission-document") }
  await writeFile(entry, `import {Plugin,Rpc} from "@opencode/plugin/effect";
import {Cause,Context,Effect,Exit} from "effect";import {readFileSync} from "node:fs";
import {acquireNativeScheduledActorTransport} from ${JSON.stringify(imports.actors)};
import {nativeInvocation} from ${JSON.stringify(imports.invocation)};
import {nativeScheduleDocumentKey,assertNativeScheduleCarrierArtifacts} from ${JSON.stringify(imports.binding)};
import {readNativeScheduleIncarnation,nativeScheduleIncarnationGuard} from ${JSON.stringify(imports.identity)};
import {assertMissionCalendarPlacement} from ${JSON.stringify(imports.placement)};
import {parseMissionDocument} from ${JSON.stringify(imports.document)};
const prefix="plugin:"+Array.from("codenomad.missions").map(c=>c.charCodeAt(0).toString(16).padStart(4,"0")).join("")+":";
const rpc=Rpc.define({id:"codenomad.stop-diagnostic",methods:{probe:{input:{type:"object"},output:{type:"object"}}},events:{}});
export default Plugin.define({id:"codenomad.stop-diagnostic",effect:ctx=>Effect.gen(function*(){
 yield*ctx.rpc.register(rpc,{probe:raw=>{const invocation=nativeInvocation(),trace=[],secrets=[];let stage="entry",writeAttempted=false;
  const scrub=value=>{let text=String(value??"");for(const secret of secrets)if(secret)text=text.replaceAll(secret,"<redacted>");return text.slice(0,32768)};
  const error=value=>({name:scrub(value?.name),message:scrub(value?.message),stack:scrub(value?.stack),code:typeof value?.code==="number"?value.code:null});
  const clone=value=>{try{structuredClone(value);return{ok:true}}catch(cause){return{ok:false,error:error(cause)}}};
  const fail=cause=>({stage,trace,writeAttempted,cause:scrub(Cause.pretty(cause))});
  return Effect.scoped(invocation.capture(Effect.gen(function*(){
   const input=raw;if(!/^[A-Za-z0-9_-]{3,100}$/.test(input.missionID)||typeof input.requestID!=="string"||typeof input.pendingID!=="string")throw Error("diagnostic-input");
   const database=yield*Context.Service("@opencode/storage/Database"),placed=yield*Context.Service("@opencode/Location");
   const query=(sql,args=[])=>database.db.$client.unsafe(sql,args).withoutTransform;
   stage="read-owned-original-stop";
   const rows=yield*query("SELECT value FROM kv WHERE key=?",[prefix+nativeScheduleDocumentKey(ctx,input.missionID)]);
   if(rows.length!==1||typeof rows[0].value!=="string"||rows[0].value.length>262144)throw Error("diagnostic-document");
   const doc=parseMissionDocument(JSON.parse(rows[0].value),{id:input.missionID,projectID:ctx.location.project.id,projectCanonical:ctx.location.project.canonical}),owner=doc.calendarOwner;
   if(doc.state!=="stopped"||doc.pending?.id!==input.pendingID||doc.projectID!==ctx.location.project.id||doc.projectCanonical!==ctx.location.project.canonical
    ||![owner?.operation,...owner?.receipts??[],owner?.lastControl].some(record=>record?.requestID===input.requestID&&record.action==="stop"))throw Error("diagnostic-original-intent");
   try{const registration=JSON.parse(readFileSync(owner.installation.registrationFile,"utf8"));if(typeof registration.password==="string")secrets.push(registration.password)}catch{}
   const incarnation=readNativeScheduleIncarnation(owner.installation.registrationFile),processGuard=nativeScheduleIncarnationGuard(owner.installation.registrationFile,incarnation);
   const current=()=>{processGuard();assertNativeScheduleCarrierArtifacts(owner.installation);return assertMissionCalendarPlacement(owner.placement,doc.configuration.roots)};
   current();stage="public-facade-get";
   const session=yield*ctx.session.get({sessionID:doc.pending.coordinatorSessionID});
   trace.push({stage,ok:session.id===doc.pending.coordinatorSessionID,sessionID:session.id});
   stage="location-clone-before-actor-acquisition";
   trace.push({stage,publicLocation:clone(ctx.location),graphLocation:clone(placed)});
   const run=effect=>invocation.check(runner=>runner(effect));
   stage="actor-acquisition";trace.push({stage,before:true});
   const acquired=yield*acquireNativeScheduledActorTransport(ctx,owner.installation,run,current).pipe(Effect.exit);
   if(Exit.isFailure(acquired))return fail(acquired.cause);
   trace.push({stage,after:true});
   return{stage:"actor-acquisition-success",trace,writeAttempted,runtimeControlPassageNotAttempted:true,
    comparability:"No observer storage facade is substituted for the actual product namespace"};
  })).pipe(Effect.catchCause(cause=>Effect.sync(()=>fail(cause)))))
 }});
})});`)
  await build({ ...nativePluginBuild, entryPoints: [entry], outfile: path.join(directory, "index.mjs"), sourcemap: "inline" })
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "codenomad-stop-diagnostic", type: "module", exports: { ".": "./index.mjs" } }))
  const sourceSHA256 = Object.fromEntries(await Promise.all(Object.entries(imports).map(async ([name, file]) => [name, createHash("sha256").update(await readFile(file)).digest("hex")])))
  return { directory, sourceSHA256 }
}
