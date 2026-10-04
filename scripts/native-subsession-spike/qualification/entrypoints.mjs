import assert from "node:assert/strict"
import { writeFile, access, readFile } from "node:fs/promises"
import { run, childCall } from "./harness.mjs"
import { backendServer } from "./backend.mjs"

await run("direct-native-entrypoints-and-owned-admission", async h => {
  h.backend = await backendServer(h)
  const rootID = await h.parent("Entry point scope")
  const profileFile = `${h.root}/profile-entrypoints.json`; await writeFile(profileFile, JSON.stringify({ environmentVariables: { QUAL_PROFILE: "ENTRYPOINT" } }))
  h.backend.profiles.set(rootID, profileFile); await h.backend.applyRoot(rootID)
  await h.control(rootID, "running", { gate: true, explicitEnvironment: true })
  h.provider.childPlans.set("entry_child", { answers: ["ENTRY_CHILD_RESULT"] })
  await h.submit(rootID, [childCall("entry_child")]); await h.wait(rootID)
  const binding = await h.binding("entry_child")
  await h.control(rootID, "stopped", { gate: true })
  const count = h.requests().length
  const direct = await h.running.client.session.prompt({ sessionID: binding.childID, text: "DIRECT_NATIVE_PROMPT_AFTER_STOP" }, h.options()); await h.wait(binding.childID)
  await assert.rejects(h.running.client.session.generate({ sessionID: binding.childID, prompt: "TRANSIENT_AFTER_STOP" }, h.options()))
  assert.equal(h.requests().length, count)
  h.observe("direct prompt is admitted but context/generate model consumption blocked", "WORKAROUND_TESTED", { rootID, childID: binding.childID, promptAdmissionID: direct.id, providerRequests: 0 })
  // The documented context/prompt hooks explicitly do not intercept shell admission.
  await h.running.client.session.shell({ sessionID: binding.childID, command: "node -e \"require('fs').writeFileSync('direct-native-shell-after-stop.txt','effect')\"" }, h.options())
  await access(`${h.project}/direct-native-shell-after-stop.txt`)
  h.observe("authenticated raw session.shell bypasses model/tool hooks", "OBSERVED_LIMIT", { rootID, childID: binding.childID, actualFilesystemEffect: true, requiresOwnedAdmissionBoundary: true })
  await assert.rejects(h.backend.proxy.session.shell({ sessionID: binding.childID, command: "node -e \"require('fs').writeFileSync('owned-shell-after-stop.txt','bad')\"" }, h.options()))
  await assert.rejects(access(`${h.project}/owned-shell-after-stop.txt`))
  await assert.rejects(h.backend.proxy.session.prompt({ sessionID: rootID, text: "OWNED_PROMPT_AFTER_STOP" }, h.options()))
  h.observe("owned authenticated descendant shell/prompt admission honors durable Stop", "WORKAROUND_TESTED", { rootID, childID: binding.childID, filesystemEffect: false, routeReceipts: h.backend.trace.filter(record => record.operation === "owned-route-denied") })

  const missingBackend = await h.parent("Detached before descendant environment admission")
  h.backend.profiles.set(missingBackend, profileFile); await h.backend.applyRoot(missingBackend)
  await h.control(missingBackend, "running", { explicitEnvironment: true })
  await h.backend.close()
  h.provider.childPlans.set("after_detach_birth", { answers: ["MUST_NOT_CONSUME"] })
  await h.submit(missingBackend, [childCall("after_detach_birth")]); await h.wait(missingBackend)
  const failed = await h.binding("after_detach_birth")
  assert.equal(h.requests(failed.childID).length, 0)
  assert.equal(h.tools(await h.messages(missingBackend)).find(tool => tool.id === "after_detach_birth").state.status, "error")
  h.observe("backend detach before admission leaves native child but fails closed pre-model", "WORKAROUND_TESTED", { binding: failed, providerRequests: 0, nativeBirthIsNotAuthorizedExecution: true })
})
