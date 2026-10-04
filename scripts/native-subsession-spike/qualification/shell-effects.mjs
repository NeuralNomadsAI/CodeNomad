import assert from "node:assert/strict"
import { writeFile, access } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
import { run, call, childCall } from "./harness.mjs"

await run("Stop-is-not-OS-shell-suspension", async h => {
  await writeFile(`${h.project}/effect.cjs`, `const fs=require('fs'),name=process.argv[2];fs.writeFileSync(name+'.started','started');const end=Date.now()+8000;const t=setInterval(()=>{if(fs.existsSync(name+'.release')){clearInterval(t);fs.writeFileSync(name+'.effect','effect');console.log('EFFECT_FINISHED');}else if(Date.now()>end){clearInterval(t);process.exit(2)}},40)`)
  const exists = async file => { try { await access(`${h.project}/${file}`); return true } catch { return false } }
  for (const [name, background, terminate] of [["fg_gate_only", false, false], ["fg_native_interrupt", false, true], ["fg_native_remove", false, true], ["bg_gate_only", true, false], ["bg_native_remove", true, true]]) {
    const rootID = await h.parent(name); await h.control(rootID, "running", { gate: true })
    // Put the actual shell at depth3, not a host-side synthetic tool call.
    h.provider.childPlans.set(name + "_1", { answers: [childCall(name + "_2")] })
    h.provider.childPlans.set(name + "_2", { answers: [childCall(name + "_3")] })
    h.provider.childPlans.set(name + "_3", { answers: [call("shell", { command: `node effect.cjs ${name}`, background }, name + "_shell")] })
    await h.submit(rootID, [childCall(name + "_1", { background })])
    const binding = await h.binding(name + "_3")
    await h.until(() => exists(name + ".started"), "actual OS shell begun: " + name)
    const shellList = await h.running.client.shell.list({ location: { directory: h.project } }, h.options())
    const shell = shellList.data.find(shell => shell.command === `node effect.cjs ${name}`)
    assert(shell && shell.status === "running")
    const counts = h.requests().length
    await h.control(rootID, "stopped", { gate: true })
    let receipt = null
    if (terminate) receipt = name.includes("remove") ? await h.running.client.shell.remove({ id: shell.id, location: { directory: h.project } }, h.options()) : await h.running.client.session.interrupt({ sessionID: rootID, resume: false }, h.options())
    await writeFile(`${h.project}/${name}.release`, "authorized private release")
    if (!terminate) await h.until(() => exists(name + ".effect"), "gate alone permits already-started OS effect")
    await h.wait(rootID); await h.wait(binding.childID); await delay(150)
    const effect = await exists(name + ".effect")
    if (!terminate) assert.equal(effect, true)
    const forbiddenRequests = h.requests().slice(counts).filter(record => [rootID, binding.childID].includes(record.sessionID))
    assert.equal(forbiddenRequests.length, 0)
    h.observe(name, terminate && !effect ? "WORKAROUND_TESTED" : "OBSERVED_LIMIT", { rootID, depth3ChildID: binding.childID, background, shellBefore: shell, receipt: receipt ?? null, filesystemEffectAfterStop: effect, providerRequestsAfterStop: 0, claim: effect ? "Already-started OS descendant effect occurred despite model gate/native cancellation; no suspension guarantee" : "Known shell effect prevented in this run; not atomic suspension" })
  }
})
