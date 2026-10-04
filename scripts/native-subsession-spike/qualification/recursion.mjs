import assert from "node:assert/strict"
import { writeFile, readFile, mkdir } from "node:fs/promises"
import { run, call, childCall } from "./harness.mjs"
import { backendServer } from "./backend.mjs"
import { writeEnvironmentProbe, fingerprintEnvironment, compareEnvironment, retainBackend, retainedWrite, recordProcessComparison, captureSourceHashes } from "./environment-evidence.mjs"

const mode = process.argv[2] ?? "all"
await run("recursion-permissions-environment:" + mode, async h => {
  const plan = (id, answers, hold = false) => h.provider.childPlans.set(id, { answers, hold })
  if (mode === "all" || mode === "recursion") {
  const chain = async (name, background = false, hold = false) => {
    const rootID = await h.parent(name)
    plan(`${name}_1`, [childCall(`${name}_2`, { background })]); plan(`${name}_2`, [childCall(`${name}_3`, { background })]); plan(`${name}_3`, ["DEPTH3_LEAF_REPORT:" + name], hold)
    await h.submit(rootID, [childCall(`${name}_1`, { background })])
    const bindings = []
    for (let i = 1; i <= 3; i++) bindings.push(await h.binding(`${name}_${i}`))
    assert.deepEqual((await h.family(bindings[2].childID)).map(session => session.id), [bindings[2].childID, bindings[1].childID, bindings[0].childID, rootID])
    return { rootID, bindings }
  }
  const foreground = await chain("foreground")
  await h.wait(foreground.rootID)
  for (const binding of foreground.bindings) {
    assert(h.requests(binding.childID).length)
    assert(h.requests(binding.parentID).some(record => JSON.stringify(record.body.messages).includes("DEPTH3_LEAF_REPORT:foreground")), "Leaf result actually consumed at every parent")
  }
  h.observe("root-child-grandchild-greatgrandchild foreground", "SUPPORTED", { ...foreground, consumedAtAllParents: true })
  const background = await chain("background", true, true)
  const leaf = background.bindings[2].childID
  await h.until(() => h.provider.holds.has(leaf), "background depth3 retained")
  await h.wait(background.rootID)
  const active = await h.running.client.session.active(h.options())
  assert(active[leaf]); h.provider.release(leaf); await h.wait(leaf)
  await h.until(() => h.requests(background.bindings[1].childID).some(record => JSON.stringify(record.body.messages).includes("DEPTH3_LEAF_REPORT:background")), "grandparent native notification consumed")
  h.observe("nested background native notification", "SUPPORTED", { ...background, activeLeafWhileRootIdle: true, leafReportConsumedByImmediateParent: true })

  const concurrent = await h.parent("Concurrent foreground/background same parent")
  plan("parallel_fg", [childCall("parallel_fg_depth2")]); plan("parallel_fg_depth2", ["PARALLEL_FG_LEAF"], true)
  plan("parallel_bg", [childCall("parallel_bg_depth2", { background: true })]); plan("parallel_bg_depth2", ["PARALLEL_BG_LEAF"], true)
  await h.submit(concurrent, [[childCall("parallel_fg"), childCall("parallel_bg", { background: true })]])
  const pfg = await h.binding("parallel_fg_depth2"), pbg = await h.binding("parallel_bg_depth2")
  await h.until(() => h.provider.holds.has(pfg.childID) && h.provider.holds.has(pbg.childID), "concurrent native deep tools")
  assert.equal((await h.family(pfg.childID)).at(-1).id, concurrent); assert.equal((await h.family(pbg.childID)).at(-1).id, concurrent)
  h.provider.release(pfg.childID); h.provider.release(pbg.childID); await h.wait(concurrent); await h.wait(pbg.childID)
  h.observe("same-parent concurrent deep foreground/background binding", "SUPPORTED", { rootID: concurrent, pfg, pbg, distinctCalls: true })
  }

  if (mode === "all" || mode === "permissions") {
  const general = await h.parent("Builtin general recursion policy negative")
  plan("general_control", [childCall("general_forbidden_child")])
  await h.submit(general, [childCall("general_control", { agent: "general" })]); await h.wait(general)
  const gb = await h.binding("general_control")
  const generalTool = h.tools(await h.messages(gb.childID)).find(tool => tool.id === "general_forbidden_child")
  h.observe("builtin general recursive invocation, not tool advertisement", generalTool?.state.status === "error" ? "OBSERVED_LIMIT" : "SUPPORTED", { binding: gb, advertisedSubagent: h.requests(gb.childID)[0].body.tools.some(tool => tool.function.name === "subagent"), actualInvocation: generalTool })
  for (const [name, permissions, agent] of [
    ["denied_birth", [{ action: "subagent", resource: "recursive", effect: "deny" }], "recursive"],
    ["primary_mode", undefined, "primary_only"],
  ]) {
    const rootID = await h.parent(name, permissions); await h.submit(rootID, [childCall(name, { agent })]); await h.wait(rootID)
    assert.equal(h.tools(await h.messages(rootID)).find(tool => tool.id === name).state.status, "error")
    assert(!(await h.rpc("inspect")).bindings.some(record => record.value.callID === name))
    h.observe(name, "SUPPORTED", { rootID, noChildBirth: true })
  }
  const inherited = await h.parent("Inheritance and parent rule change", [{ action: "shell", resource: "*", effect: "deny" }])
  plan("inherited_first", [childCall("inherited_grandchild")]); plan("inherited_grandchild", ["INHERITED_RULE_PROBE"])
  await h.submit(inherited, [childCall("inherited_first")]); await h.wait(inherited)
  const first = await h.binding("inherited_first"), grand = await h.binding("inherited_grandchild")
  assert(!h.requests(first.childID)[0].body.tools.some(tool => tool.function.name === "shell")); assert(!h.requests(grand.childID)[0].body.tools.some(tool => tool.function.name === "shell"))
  await h.running.client.session.update({ sessionID: inherited, permissions: [{ action: "shell", resource: "*", effect: "allow" }] }, h.options())
  plan("inherited_continue", ["CONTINUATION_RULE_PROBE"])
  await h.submit(inherited, [childCall("inherited_continue", { sessionID: first.childID })]); await h.wait(inherited)
  const continuation = h.requests(first.childID).at(-1)
  plan("new_after_rules", ["NEW_RULE_PROBE"])
  await h.submit(inherited, [childCall("new_after_rules")]); await h.wait(inherited)
  const changed = await h.binding("new_after_rules")
  h.observe("permission birth snapshot and existing-child continuation", "SUPPORTED", { first, grand, existingChildHasShellAfterParentAllow: continuation.body.tools.some(tool => tool.function.name === "shell"), newChildHasShell: h.requests(changed.childID)[0].body.tools.some(tool => tool.function.name === "shell") })
  }

  if (mode === "all" || mode === "environment") {
  h.result.environmentEvidenceRevision = { version: 2, sourceHashes: await captureSourceHashes(), historicalArtifactsNotRetrofitted: true }
  h.result.daemonStartupFingerprint = fingerprintEnvironment(process.env)
  h.backend = await backendServer(h)
  await writeEnvironmentProbe(h.project)
  const profile = async (marker, retired) => {
    const file = `${h.root}/profile-${marker}.json`; await writeFile(file, JSON.stringify({ environmentVariables: { QUAL_PROFILE: marker, QUAL_COMPLEX_VALUE: `private synthetic ${marker} α | spaces = line\nnext`, ...(retired ? { QUAL_RETIRED: retired } : {}) } })); return file
  }
  const probe = label => call("shell", { command: `node probe.cjs ${label}.json` }, `probe_${label}`)
  const measure = async (sessionID, label) => {
    await h.running.client.session.shell({ sessionID, command: `node probe.cjs ${label}-api.json` }, h.options())
    const tool = JSON.parse(await readFile(`${h.project}/${label}.json`, "utf8")), sessionShell = JSON.parse(await readFile(`${h.project}/${label}-api.json`, "utf8"))
    return { tool, sessionShell, toolVsAPI: compareEnvironment(tool.env, sessionShell.env), toolVsDaemonStartup: compareEnvironment(h.result.daemonStartupFingerprint, tool.env), completeChildEnvironmentAdmissionClaimed: false }
  }
  const measuredAdmission = async (binding, label) => {
    retainBackend(h, h.backend, "same-call-process-comparison:" + label)
    return recordProcessComparison(h, binding, label, retainedWrite(h.result.allBackendTraces, binding))
  }
  const measuredRoot = async (rootID, label) => {
    retainBackend(h, h.backend, "root-process-comparison:" + label)
    const sourceWrite = h.backend.trace.filter(record => record.operation === "root-environment" && record.sessionID === rootID).at(-1)
    return recordProcessComparison(h, { rootID, parentID: null, childID: rootID, callID: `probe_${label}`, messageID: null }, label, sourceWrite, { root: true })
  }
  const envRoots = []
  for (const marker of ["A1", "B1"]) {
    const rootID = await h.parent("Native raw profile " + marker); envRoots.push(rootID)
    h.backend.profiles.set(rootID, await profile(marker, "old-" + marker)); await h.backend.applyRoot(rootID)
    plan(`raw_${marker}`, [probe(`raw_${marker}`), childCall(`raw_grand_${marker}`)]); plan(`raw_grand_${marker}`, [probe(`raw_grand_${marker}`)])
    await h.submit(rootID, [probe(`root_${marker}`), childCall(`raw_${marker}`)]); await h.wait(rootID)
    await measuredRoot(rootID, `root_${marker}`)
    const cb = await h.binding(`raw_${marker}`), gcb = await h.binding(`raw_grand_${marker}`)
    h.observe("raw native profile inheritance " + marker, "OBSERVED_LIMIT", { rootID, child: await measure(cb.childID, `raw_${marker}`), grandchild: await measure(gcb.childID, `raw_grand_${marker}`) })
  }
  const explicit = []
  for (let i = 0; i < envRoots.length; i++) {
    const rootID = envRoots[i], marker = i ? "B1" : "A1"
    await h.control(rootID, "running", { explicitEnvironment: true })
    plan(`clean_${marker}`, [probe(`clean_${marker}`), childCall(`clean_grand_${marker}`)], true)
    plan(`clean_grand_${marker}`, [probe(`clean_grand_${marker}`)])
    await h.submit(rootID, [childCall(`clean_${marker}`)])
    const cb = await h.binding(`clean_${marker}`); explicit.push({ rootID, cb, marker })
  }
  await h.until(() => explicit.every(item => h.provider.holds.has(item.cb.childID)), "independent clean children simultaneous")
  for (const item of explicit) h.provider.release(item.cb.childID)
  for (const item of explicit) {
    await h.wait(item.rootID); const grand = await h.binding(`clean_grand_${item.marker}`)
    for (const [binding, label] of [[item.cb, `clean_${item.marker}`], [grand, `clean_grand_${item.marker}`]]) {
      const measured = await measuredAdmission(binding, label)
      assert.equal(measured.tool.marker, item.marker); assert.equal(measured.tool.retired, "old-" + item.marker)
      assert.equal(measured.tool.db, false); assert.equal(measured.tool.password, false); assert.equal(measured.tool.state, false); assert(measured.tool.path)
      h.observe("pre-first-provider fresh complete descendant environment " + label, "WORKAROUND_TESTED", { binding, measured })
    }
  }
  const a = explicit[0]; h.backend.profiles.set(a.rootID, await profile("A2"))
  await h.backend.applyRoot(a.rootID)
  plan("clean_continue_A2", [probe("clean_continue_A2"), childCall("clean_grand_continue_A2", { sessionID: (await h.binding("clean_grand_A1")).childID })]); plan("clean_grand_continue_A2", [probe("clean_grand_continue_A2")])
  await h.submit(a.rootID, [probe("root_A2"), childCall("clean_continue_A2", { sessionID: a.cb.childID })]); await h.wait(a.rootID)
  await measuredRoot(a.rootID, "root_A2")
  const continuationBinding = await h.binding("clean_continue_A2"), grandContinuation = await h.binding("clean_grand_continue_A2")
  for (const [binding, label] of [[continuationBinding, "clean_continue_A2"], [grandContinuation, "clean_grand_continue_A2"]]) {
    const measured = await measuredAdmission(binding, label); assert.equal(measured.tool.marker, "A2"); assert.equal(measured.tool.retired, null)
    h.observe("recursive same-child continuation profile replacement " + label, "WORKAROUND_TESTED", { binding, measured })
  }
  const b = explicit[1]
  plan("detach_bound", [probe("detach_bound")], true)
  await h.submit(b.rootID, [childCall("detach_bound")]); const detachBinding = await h.binding("detach_bound")
  await h.until(() => h.provider.holds.has(detachBinding.childID), "already-admitted child before backend detach")
  await h.backend.close(); h.provider.release(detachBinding.childID); await h.wait(b.rootID)
  h.observe("actual backend detach after child admission", "SUPPORTED", { binding: detachBinding, measured: await measuredAdmission(detachBinding, "detach_bound"), succeeded: (await h.running.client.session.get({ sessionID: detachBinding.childID })).outcome })
  h.result.environmentEvidenceRevision.sourceHashesAfter = await captureSourceHashes()
  assert.deepEqual(h.result.environmentEvidenceRevision.sourceHashesAfter, h.result.environmentEvidenceRevision.sourceHashes)
  }
})
