import assert from "node:assert/strict"
import { createServer } from "node:http"
export async function providerServer() {
  const requests = [], plans = new Map(), childPlans = new Map(), holds = new Map(), holdNext = new Set(), holdSteps = new Map()
  let failure
  const server = createServer(async (request, response) => {
    try {
      let raw = ""
      for await (const chunk of request) { raw += chunk; assert(raw.length <= 2 * 1024 * 1024) }
      const body = JSON.parse(raw), sessionID = request.headers["x-authority-session"], kind = request.headers["x-authority-kind"], callID = request.headers["x-child-call"]
      if (kind === "primary" && childPlans.has(callID)) {
        const plan = childPlans.get(callID); childPlans.delete(callID); plans.set(sessionID, plan.answers)
        if (plan.hold) holdNext.add(sessionID)
      }
      requests.push({ index: requests.length, time: Date.now(), sessionID, kind, callID, body }); assert(requests.length <= 200)
      const sessionStep = requests.filter(record => record.sessionID === sessionID && record.kind === "primary").length
      if (holdNext.delete(sessionID) || holdSteps.get(sessionID) === sessionStep) await new Promise(resolve => { holds.set(sessionID, resolve); response.once("close", resolve) })
      if (response.destroyed) return
      let answer = plans.get(sessionID)?.shift() ?? "NATIVE_CONSUMED:" + JSON.stringify(body.messages?.filter(message => message.role === "tool" || message.role === "user").slice(-4)).slice(-12000)
      if (typeof answer === "function") answer = answer(body)
      const calls = Array.isArray(answer) ? answer : typeof answer === "string" ? null : [answer]
      if (calls) for (const call of calls) assert(body.tools.some(tool => tool.function.name === call.tool), "Requested tool absent: " + call.tool)
      const delta = calls ? { role: "assistant", tool_calls: calls.map((call, index) => ({ index, id: call.id, type: "function", function: { name: call.tool, arguments: JSON.stringify(call.input) } })) } : { role: "assistant", content: answer }
      response.setHeader("content-type", "text/event-stream")
      for (const [value, finish_reason] of [[delta, null], [{}, calls ? "tool_calls" : "stop"]]) response.write(`data: ${JSON.stringify({ id: "qualification", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`)
      response.end("data: [DONE]\n\n")
    } catch (error) { failure = error; response.destroy() }
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  return { plans, childPlans, holds, holdNext, holdSteps, requests, get failure() { return failure }, url: `http://127.0.0.1:${server.address().port}/v1`,
    release(id) { holds.get(id)?.(); holds.delete(id) }, async close() { for (const resolve of holds.values()) resolve(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}
