import assert from "node:assert/strict"
import { inspect } from "node:util"
import { once } from "node:events"
import { createServer, type RequestListener } from "node:http"
import type { AddressInfo } from "node:net"
import { test, type TestContext } from "node:test"
import Fastify from "fastify"
import type { Logger } from "../../logger"
import type { SettingsService } from "../../settings/service"
import { SpeechService } from "../../speech/service"
import { registerSpeechRoutes } from "./speech"

async function fixture(t: TestContext, respond: RequestListener, apiKey = "test-only-key") {
  const upstream = createServer(respond)
  upstream.listen(0, "127.0.0.1")
  t.after(() => { upstream.closeAllConnections(); upstream.close() })
  await once(upstream, "listening")
  const { port } = upstream.address() as AddressInfo
  const app = Fastify()
  t.after(() => app.close())
  const settings = { getOwner: () => ({ speech: {
    apiKey, baseUrl: `http://127.0.0.1:${port}/v1`, sttModel: "test-transcriber",
  } }) } as unknown as SettingsService
  const log = { child: () => log, info() {} } as unknown as Logger
  registerSpeechRoutes(app, { speechService: new SpeechService(settings, log) })
  const url = await app.listen({ port: 0, host: "127.0.0.1" })
  return (signal?: AbortSignal, mode = "transcribe") => fetch(`${url}/api/speech/${mode}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, signal,
    body: JSON.stringify(mode === "transcribe" ? { audioBase64: "YXVkaW8=", mimeType: "audio/mp4" } : { text: "Classic summary" }),
  })
}

test("the OpenAI SDK never logs a speech credential, even with debug enabled", { timeout: 8000 }, async t => {
  const key = "speech-credential-sentinel-not-a-real-key"
  const oldLevel = process.env.OPENAI_LOG
  process.env.OPENAI_LOG = "debug"
  t.after(() => { if (oldLevel === undefined) delete process.env.OPENAI_LOG; else process.env.OPENAI_LOG = oldLevel })
  const logs: string[] = []
  for (const method of ["debug", "info", "warn", "error", "log"] as const) {
    t.mock.method(console, method, (...args: unknown[]) => { logs.push(inspect(args)) })
  }
  let received: string | undefined
  const send = await fixture(t, (request, response) => {
    received = request.headers.authorization
    request.resume()
    response.writeHead(403, { "Content-Type": "text/plain" })
    response.end(`Invalid credentials: ${received}`)
  }, key)
  const response = await send()
  assert.equal(response.status, 502)
  assert.equal(received, `Bearer ${key}`)
  assert.ok(!logs.join("\n").includes(key), "captured SDK output included the credential")
})

test("disconnecting the dictation caller closes the provider upload without retry or fallback", { timeout: 8000 }, async t => {
  let started!: () => void, closed!: () => void, calls = 0
  const providerStarted = new Promise<void>(resolve => { started = resolve })
  const providerClosed = new Promise<void>(resolve => { closed = resolve })
  const send = await fixture(t, (request, response) => {
    calls++
    request.resume()
    request.once("end", started)
    response.once("close", closed)
  })
  const controller = new AbortController()
  const result = assert.rejects(send(controller.signal), { name: "AbortError" })
  await providerStarted
  controller.abort()
  await result
  await providerClosed
  assert.equal(calls, 1)
})

for (const partial of [false, true]) {
  test(`disconnecting synthesis ${partial ? "after the first audio chunk" : "before headers"} closes the provider request`, { timeout: 8000 }, async t => {
    let started!: () => void, closed!: () => void
    const providerStarted = new Promise<void>(resolve => { started = resolve })
    const providerClosed = new Promise<void>(resolve => { closed = resolve })
    const send = await fixture(t, (request, response) => {
      assert.equal(request.url, "/v1/audio/speech")
      response.once("close", closed)
      request.resume()
      request.once("end", () => {
        if (partial) {
          response.writeHead(200, { "Content-Type": "audio/mpeg" })
          response.write("audio")
        }
        started()
      })
    })
    const controller = new AbortController()
    const pending = send(controller.signal, "synthesize/stream")
    if (partial) {
      const reader = (await pending).body!.getReader()
      assert.equal(Buffer.from((await reader.read()).value!).toString(), "audio")
      const cancelled = assert.rejects(reader.read(), { name: "AbortError" })
      controller.abort()
      await cancelled
    } else {
      const cancelled = assert.rejects(pending, { name: "AbortError" })
      await providerStarted
      controller.abort()
      await cancelled
    }
    await providerClosed
  })
}

test("the synthesis route serves full binary audio with the provider MIME type", async t => {
  const send = await fixture(t, (request, response) => {
    assert.equal(request.url, "/v1/audio/speech")
    request.resume()
    response.writeHead(200, { "Content-Type": "audio/wav" })
    response.write(Buffer.from([0, 128]))
    response.end(Buffer.from([255]))
  })
  const response = await send(undefined, "synthesize/stream")
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("content-type"), "audio/wav")
  assert.equal(response.headers.get("cache-control"), "no-store")
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([0, 128, 255]))
  const removed = await send(undefined, "synthesize")
  assert.equal(removed.status, 404)
  await removed.body?.cancel()
})

test("a format rejection keeps the API default-format path, but transient failures are sent only once", { timeout: 8000 }, async t => {
  const bodies: string[] = []
  const send = await fixture(t, async (request, response) => {
    assert.equal(request.url, "/v1/audio/transcriptions")
    let body = ""
    for await (const chunk of request) body += chunk.toString()
    bodies.push(body)
    const status = [400, 200, 503, 400][bodies.length - 1] ?? 503
    response.writeHead(status, { "Content-Type": "application/json" })
    const message = bodies.length === 1 ? "Unsupported response format" : "Provider rejected the request"
    response.end(JSON.stringify(status === 200 ? { text: "transcript" } : { error: { message } }))
  })
  const response = await send()
  assert.equal(response.status, 200)
  assert.equal((await response.json()).text, "transcript")
  assert.match(bodies[0]!, /verbose_json/)
  assert.doesNotMatch(bodies[1]!, /response_format/)
  for (const body of bodies) assert.match(body, /filename="prompt-input.m4a"\r\nContent-Type: audio\/mp4/)
  assert.equal((await send()).status, 502)
  assert.equal((await send()).status, 502)
  assert.equal(bodies.length, 4)
})
