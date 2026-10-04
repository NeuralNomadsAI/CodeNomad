import assert from "node:assert/strict"
import { run, childCall } from "./harness.mjs"
await run("builtin-general-uncontaminated-policy", async h => {
  const rootID = await h.parent("Builtin General without global star allow")
  h.provider.childPlans.set("uncontaminated_general", { answers: [body => body.tools.some(tool => tool.function.name === "subagent") ? childCall("uncontaminated_general_nested") : "GENERAL_SUBAGENT_NATIVE_FILTERED"] })
  await h.submit(rootID, [childCall("uncontaminated_general", { agent: "general" })]); await h.wait(rootID)
  const binding = await h.binding("uncontaminated_general")
  const child = await h.running.client.session.get({ sessionID: binding.childID })
  assert.equal(child.agent, "general")
  const advertised = h.requests(binding.childID)[0].body.tools.some(tool => tool.function.name === "subagent")
  const tool = h.tools(await h.messages(binding.childID)).find(tool => tool.id === "uncontaminated_general_nested")
  assert(!advertised || tool?.state.status === "error")
  assert(!(await h.rpc("inspect")).bindings.some(record => record.value.callID === "uncontaminated_general_nested"))
  h.observe("builtin General cannot recurse with native unmodified deny and no global star allow", "SUPPORTED", { binding, advertisedSubagent: advertised, actualInvocation: tool ?? null, nestedBirths: 0, customRecursiveAgentStillLegal: true, noEngineImpossibilityClaim: true })
})
