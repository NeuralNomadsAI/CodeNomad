import assert from "node:assert/strict"
import { startProvider } from "../missions-authority-spike/provider.mjs"

// Compose the existing deterministic SSE provider; do not fork its implementation.
export async function startChildProvider() {
  const provider = await startProvider()
  const childPlans = new Map(), observations = [], childSessions = new Map()
  let observationFailure
  provider.server.prependListener("request", request => {
    const sessionID = request.headers["x-authority-session"], kind = request.headers["x-authority-kind"]
    const callID = request.headers["x-child-call"]
    if (kind === "primary" && callID && childPlans.has(callID)) {
      const plan = childPlans.get(callID); childPlans.delete(callID)
      childSessions.set(callID, sessionID)
      provider.answers.set(sessionID, plan.answers)
      if (plan.hold) provider.holdNext.add(sessionID)
    }
    let raw = ""
    request.on("data", data => { raw += data; if (raw.length > 2 * 1024 * 1024) request.destroy(new Error("Private provider body limit")) })
    request.on("end", () => {
      try {
        const body = JSON.parse(raw)
        observations.push({ sessionID, kind, callID: callID ?? null, model: body.model,
          tools: (body.tools ?? []).map(tool => tool.function.name),
          subagentSchema: body.tools?.find(tool => tool.function.name === "subagent")?.function.parameters ?? null, messages: body.messages })
        assert(observations.length <= 160, "Bounded provider budget")
      } catch (error) { observationFailure = error; request.destroy(error) }
    })
  })
  Object.defineProperty(provider, "observationFailure", { get: () => observationFailure })
  return Object.assign(provider, { childPlans, observations, childSessions })
}
