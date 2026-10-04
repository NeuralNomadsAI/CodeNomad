import assert from "node:assert/strict"
import { createServer } from "node:http"

function emit(response, answer) {
  response.setHeader("content-type", "text/event-stream")
  const delta = typeof answer === "string" ? { role: "assistant", content: answer } : {
    role: "assistant", tool_calls: [{ index: 0, id: answer.id, type: "function", function: { name: answer.tool, arguments: JSON.stringify(answer.input) } }],
  }
  for (const [value, finish_reason] of [[delta, null], [{}, typeof answer === "string" ? "stop" : "tool_calls"]]) {
    response.write(`data: ${JSON.stringify({ id: "authority", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`)
  }
  response.end("data: [DONE]\n\n")
}
export async function startProvider() {
  const requests = [], holds = new Map(), holdNext = new Set(), answers = new Map()
  let failure
  const server = createServer(async (request, response) => {
    try {
      let raw = ""
      for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw), sessionID = request.headers["x-authority-session"], kind = request.headers["x-authority-kind"]
      requests.push({ sessionID, kind, messages: JSON.stringify(body.messages), tools: (body.tools ?? []).map(t => t.function.name) })
      if (kind === "primary") {
        if (holdNext.delete(sessionID)) await new Promise(resolve => { holds.set(sessionID, resolve); response.once("close", resolve) })
        if (response.destroyed) return
        const answer = answers.get(sessionID)?.shift() ?? "AUTHORITY_NATIVE_DONE"
        if (typeof answer !== "string") assert(body.tools.some(t => t.function.name === answer.tool), "Requested native tool absent")
        emit(response, answer)
      } else if (body.stream) emit(response, "Private title")
      else { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ id: "authority", choices: [{ message: { role: "assistant", content: "Private title" }, finish_reason: "stop" }] })) }
    } catch (error) { failure = error; response.destroy() }
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  return { server, requests, holds, holdNext, answers, get failure() { return failure },
    url: `http://127.0.0.1:${server.address().port}/v1`,
    release(id) { holds.get(id)?.(); holds.delete(id) },
    async close() { for (const resolve of holds.values()) resolve(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) },
  }
}
