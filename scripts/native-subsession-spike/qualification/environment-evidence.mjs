import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile, readdir, writeFile } from "node:fs/promises"

export const EXPECTED_ABSENT = ["OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD", "CODENOMAD_SERVER_PASSWORD", "CODENOMAD_AUTOMATION_BRIDGE_TOKEN", "CODENOMAD_BOOTSTRAP_TOKEN", "OPENCODE_DB", "XDG_STATE_HOME"]

// Exactly this function runs on the dispatch map and inside both real probes.
// Case-fold only keys. Values are never normalized, filtered or logged.
export function fingerprintEnvironment(environment) {
  const folded = new Map()
  for (const [name, value] of Object.entries(environment)) {
    if (typeof value !== "string") throw new Error("Non-string environment value: " + name)
    const key = name.toUpperCase(), previous = folded.get(key)
    if (previous && previous.value !== value) throw new Error("Conflicting Windows environment aliases: " + key)
    if (previous) previous.aliases.push(name)
    else folded.set(key, { value, aliases: [name] })
  }
  const pairs = [...folded].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  return { format: "windows-key-uppercase-exact-value-v1", rawKeyCount: Object.keys(environment).length, keyCount: pairs.length,
    canonicalSHA256: createHash("sha256").update(JSON.stringify(pairs.map(([key, item]) => [key, item.value]))).digest("hex"),
    keys: pairs.map(([key, item]) => ({ key, aliases: item.aliases.sort(), valueSHA256: createHash("sha256").update(item.value).digest("hex") })) }
}

export function compareEnvironment(source, runtime) {
  assert.equal(source.format, runtime.format)
  const a = new Map(source.keys.map(item => [item.key, item])), b = new Map(runtime.keys.map(item => [item.key, item]))
  const missing = [...a.keys()].filter(key => !b.has(key)), extra = [...b.keys()].filter(key => !a.has(key))
  const mismatched = [...a.keys()].filter(key => b.has(key) && a.get(key).valueSHA256 !== b.get(key).valueSHA256)
  const caseChanges = [...a.keys()].filter(key => b.has(key) && JSON.stringify(a.get(key).aliases) !== JSON.stringify(b.get(key).aliases))
  return { sourceKeyCount: source.keyCount, runtimeKeyCount: runtime.keyCount, sourceSHA256: source.canonicalSHA256, runtimeSHA256: runtime.canonicalSHA256,
    missing, extra, mismatched, caseChanges, sourceAllKeysEquivalent: !missing.length && !mismatched.length,
    fullProcessEnvironmentEqual: source.canonicalSHA256 === runtime.canonicalSHA256 && !missing.length && !extra.length && !mismatched.length }
}

export async function writeEnvironmentProbe(project) {
  await writeFile(`${project}/probe.cjs`, `const {createHash}=require('node:crypto');const fingerprintEnvironment=${fingerprintEnvironment.toString()};const e=process.env;const env=fingerprintEnvironment(e);const absent=${JSON.stringify(EXPECTED_ABSENT)}.map(key=>({key,absent:!env.keys.some(item=>item.key===key)}));require('node:fs').writeFileSync(process.argv[2],JSON.stringify({marker:e.QUAL_PROFILE??null,retired:e.QUAL_RETIRED??null,db:!!e.OPENCODE_DB,password:!!e.OPENCODE_SERVER_PASSWORD,state:!!e.XDG_STATE_HOME,path:!!e.PATH,env,absent,capturedAt:Date.now()}));console.log('PRIVATE_FULL_ENV_FINGERPRINT_SAVED')`)
}

export function retainBackend(h, backend, checkpoint) {
  const frame = { phase: h.result.phase, backendID: backend.backendID, backendGeneration: backend.backendGeneration, checkpoint, capturedAt: Date.now(), trace: structuredClone(backend.trace) }
  h.result.allBackendTraces ??= []
  h.result.allBackendTraces.push(frame)
  assert(h.result.allBackendTraces.length <= 40, "Bounded immutable backend trace frames")
  return frame
}

export function retainedWrite(frames, binding) {
  const writes = frames.flatMap(frame => Array.isArray(frame) ? frame : frame.trace).filter(record => record.operation === "environment-written"
    && record.callID === binding.callID && record.childID === binding.childID && record.messageID === binding.messageID)
  const unique = [...new Map(writes.map(record => [record.dispatchID ?? JSON.stringify(record), record])).values()]
  assert.equal(unique.length, 1, "Missing/duplicate exact retained environment write: " + binding.callID)
  return unique[0]
}

export async function recordProcessComparison(h, binding, label, sourceWrite, { root = false } = {}) {
  const beforeMessages = await h.messages(binding.childID)
  const toolMessage = beforeMessages.find(message => message.content?.some(part => part.type === "tool" && part.id === `probe_${label}`))
  assert(toolMessage, "Actual native shell Tool message for " + label)
  const beforeIDs = new Set(beforeMessages.map(message => message.id)), apiDispatchAt = Date.now()
  await h.running.client.session.shell({ sessionID: binding.childID, command: `node probe.cjs ${label}-api.json` }, h.options())
  const apiCompletedAt = Date.now(), afterMessages = await h.messages(binding.childID)
  const apiMessage = afterMessages.find(message => !beforeIDs.has(message.id) && message.type === "shell")
  const tool = JSON.parse(await readFile(`${h.project}/${label}.json`, "utf8")), sessionShell = JSON.parse(await readFile(`${h.project}/${label}-api.json`, "utf8"))
  const toolVsSource = compareEnvironment(sourceWrite.sourceFingerprint, tool.env), apiVsSource = compareEnvironment(sourceWrite.sourceFingerprint, sessionShell.env)
  const toolVsAPI = compareEnvironment(tool.env, sessionShell.env)
  const configuredTool = compareEnvironment(sourceWrite.profileFingerprint, tool.env), configuredAPI = compareEnvironment(sourceWrite.profileFingerprint, sessionShell.env)
  const inputToProfile = compareEnvironment(sourceWrite.profileFingerprint, sourceWrite.sourceFingerprint)
  assert(inputToProfile.sourceAllKeysEquivalent, "Exact configured profile represented in complete source-built map")
  const firstProvider = root ? h.requests(binding.childID).find(record => record.time >= sourceWrite.writtenAt) : h.requests(binding.childID).find(record => record.callID === binding.callID)
  assert(firstProvider && sourceWrite.writtenAt <= firstProvider.time, "Same-call complete ENV write precedes first provider")
  if (!root) {
    assert.equal(sourceWrite.callID, binding.callID); assert.equal(sourceWrite.messageID, binding.messageID)
    assert.equal(sourceWrite.childID, binding.childID); assert.equal(sourceWrite.generation, binding.generation)
  }
  const safe = probe => { for (const item of probe.absent) assert(item.absent, "Private variable absent: " + item.key) }
  // Raw-inheritance comparisons deliberately record unsafe startup variables.
  if (sourceWrite.admittedProcessExpected !== false) { safe(tool); safe(sessionShell); assert(configuredTool.sourceAllKeysEquivalent && configuredAPI.sourceAllKeysEquivalent) }
  const comparison = { phase: h.result.phase, label, binding, backendID: sourceWrite.backendID, backendGeneration: sourceWrite.backendGeneration, dispatchID: sourceWrite.dispatchID,
    sourceReadOrdinal: sourceWrite.sourceReadOrdinal, settingsReadsBefore: sourceWrite.settingsReadsBefore, settingsReadsAfter: sourceWrite.settingsReadsAfter,
    sourceBuiltAt: sourceWrite.sourceBuiltAt, dispatchAt: sourceWrite.dispatchAt, writtenAt: sourceWrite.writtenAt, firstProvider: { index: firstProvider.index, time: firstProvider.time, sessionID: firstProvider.sessionID, callID: firstProvider.callID ?? null },
    toolMessageID: toolMessage.id, toolCallID: `probe_${label}`, apiMessageID: apiMessage?.id ?? null, apiDispatchAt, apiCompletedAt,
    sourceFingerprint: sourceWrite.sourceFingerprint, profileFingerprint: sourceWrite.profileFingerprint, tool, sessionShell,
    inputToProfile, toolVsSource, apiVsSource, toolVsAPI, configuredTool, configuredAPI,
    completeInputDispatchVerified: true, scope: toolVsSource.fullProcessEnvironmentEqual && apiVsSource.fullProcessEnvironmentEqual ? "EQUAL_FULL_PROCESS_ENV" : toolVsSource.sourceAllKeysEquivalent && apiVsSource.sourceAllKeysEquivalent ? "ALL_SOURCE_KEYS_EQUIVALENT_WITH_OBSERVED_EXTRAS" : "FULL_PROCESS_ENV_DIFFERENCES_RETAINED" }
  h.result.environmentComparisons ??= []; h.result.environmentComparisons.push(comparison)
  console.log(`ENV ${label} source=${sourceWrite.sourceFingerprint.keyCount} tool=${tool.env.keyCount} api=${sessionShell.env.keyCount} missing=${toolVsSource.missing.join(',')} extra=${toolVsSource.extra.join(',')} mismatch=${toolVsSource.mismatched.join(',')} tool/API=${toolVsAPI.fullProcessEnvironmentEqual}`)
  return comparison
}

export async function captureSourceHashes() {
  const base = new URL("./", import.meta.url), result = {}
  for (const name of (await readdir(base)).filter(name => name.endsWith(".mjs") || name === "RESULTS.json").sort()) result[`scripts/native-subsession-spike/qualification/${name}`] = createHash("sha256").update(await readFile(new URL(name, base))).digest("hex")
  return result
}
