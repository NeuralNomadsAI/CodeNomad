import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { nativePluginBuild } from "../packages/server/scripts/native-plugin-build.mjs"

export async function buildControlTraceBundle(root, registrationFile, secrets) {
  const directory = path.join(root, "diagnostic-runtime"), logFile = path.join(root, "product-control-trace.jsonl")
  await mkdir(directory)
  const working = fileURLToPath(new URL("../packages/server", import.meta.url))
  const source = path.join(working, "src/opencode/missions/managed-owner-plugin.ts")
  const original = await readFile(path.join(working, "dist/plugins/missions/plugin.mjs"))
  const options = { ...nativePluginBuild, absWorkingDir: working, entryPoints: { plugin: source }, outdir: directory, outExtension: { ".js": ".mjs" } }
  const plain = await build({ ...options, write: false })
  const digest = value => createHash("sha256").update(value).digest("hex")
  assert.equal(digest(original), "3578b0357396e1834221a0f37159a8fe2d6a8a63f81fcad11b3d364b1dca0c10")
  assert.equal(digest(plain.outputFiles[0].contents), digest(original), "The uninstrumented source build must reproduce the exact failing bundle")
  const once = (text, needle, replacement) => {
    assert.equal(text.split(needle).length, 2, `Diagnostic insertion must be unique: ${needle.slice(0, 60)}`)
    return text.replace(needle, replacement)
  }
  let sourceSHA256
  await build({ ...options, plugins: [{ name: "private-control-trace", setup(esbuild) {
    esbuild.onLoad({ filter: /native-mission-schedule-control\.ts$/ }, async args => {
      let text = await readFile(args.path, "utf8"); sourceSHA256 = digest(text); text = text.replaceAll("\r\n", "\n")
      text = once(text, 'import { Effect } from "effect"', 'import { Effect } from "effect"\nimport { Cause as __diagCause } from "effect"\nimport { appendFileSync as __diagAppend, readFileSync as __diagRead } from "node:fs"')
      text += `\nlet __diagCount=0;\nconst __diagClean=(value:unknown)=>{let text=String(value??"");const hidden=${JSON.stringify(secrets)};try{const registration=JSON.parse(__diagRead(${JSON.stringify(registrationFile)},"utf8"));if(typeof registration.password==="string"){hidden.push(registration.password,Buffer.from("opencode:"+registration.password).toString("base64"))}}catch{};for(const secret of hidden)if(secret)text=text.replaceAll(secret,"<redacted>");return text.slice(0,24576)};\nconst __diag=(data:Record<string,unknown>)=>{if(data.action!=="stop"||__diagCount++>=64)return;try{__diagAppend(${JSON.stringify(logFile)},JSON.stringify({...data,at:Date.now(),pid:process.pid})+"\\n")}catch{}};\n`
      text = once(text,
        'const lifecycle = yield* acquireNativeScheduledActorTransport(ctx, installation, run, current).pipe(Effect.catchCause(cause =>\n    interruption ? Effect.succeed(undefined) : Effect.failCause(cause)))',
        'const lifecycle = yield* acquireNativeScheduledActorTransport(ctx, installation, run, current).pipe(Effect.tap(() => Effect.sync(() => __diag({stage:"actor-acquisition-success",action,requestID}))), Effect.catchCause(cause => { __diag({stage:"actor-acquisition-failure",action,requestID,cause:__diagClean(__diagCause.pretty(cause))}); return interruption ? Effect.succeed(undefined) : Effect.failCause(cause) }))')
      text = once(text,
        'const runtime = yield* acquireNativeScheduledPassageRuntime(ctx, run, { lifecycle }).pipe(Effect.catchCause(cause =>\n    interruption ? Effect.succeed(undefined) : Effect.failCause(cause)))',
        'const runtime = yield* acquireNativeScheduledPassageRuntime(ctx, run, { lifecycle }).pipe(Effect.tap(() => Effect.sync(() => __diag({stage:"runtime-acquisition-success",action,requestID}))), Effect.catchCause(cause => { __diag({stage:"runtime-acquisition-failure",action,requestID,cause:__diagClean(__diagCause.pretty(cause))}); return interruption ? Effect.succeed(undefined) : Effect.failCause(cause) }))')
      const condition = 'if (actorControl && doc.pending && doc.calendarOwner && scheduledActorCalendarBarrier(doc.calendarOwner, actorControl.requestID, actorAction)) {'
      text = once(text, condition,
        '__diag({stage:"before-actor-control",action,requestID,state:doc.state,hasPending:!!doc.pending,actorRequestID:actorControl?.requestID??null,actorAction:actorControl?.action??null,actorPending:actorControl?.pending??null,barrier:!!(actorControl&&doc.pending&&doc.calendarOwner&&scheduledActorCalendarBarrier(doc.calendarOwner,actorControl.requestID,actorAction)),runtime:!!runtime,lifecycle:!!lifecycle,operationAction:doc.calendarOwner?.operation.action,operationPending:doc.calendarOwner?.operation.pending});\n    ' + condition)
      text = once(text,
        'try { return (await runtime.controlPassage({ ...entry, requestID: actorControl.requestID, action: actorAction })).pending }\n        catch { return true }',
        'try { __diag({stage:"before-real-controlPassage",action,requestID}); const result = await runtime.controlPassage({ ...entry, requestID: actorControl.requestID, action: actorAction }); __diag({stage:"after-real-controlPassage",action,requestID,pending:result.pending}); return result.pending }\n        catch(error) { __diag({stage:"real-controlPassage-catch",action,requestID,name:__diagClean((error as Error)?.name),message:__diagClean((error as Error)?.message),stack:__diagClean((error as Error)?.stack)}); return true }')
      return { contents: text, loader: "ts", resolveDir: path.dirname(args.path) }
    })
  } }] })
  const file = path.join(directory, "plugin.mjs"), sha256 = digest(await readFile(file))
  assert.notEqual(sha256, digest(original))
  const manifest = { file, sha256, originalSHA256: digest(original), sourceSHA256, logFile, instrumentationOnly: true }
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2))
  return manifest
}
