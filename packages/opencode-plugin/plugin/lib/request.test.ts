import assert from "node:assert/strict"
import { createServer } from "node:http"
import https from "node:https"
import { test } from "node:test"

import { createCodeNomadRequester } from "./request"

test("plugin HTTPS requests retain native certificate verification", async () => {
  const originalRequest = https.request
  let requestOptions: https.RequestOptions | undefined
  https.request = ((options: https.RequestOptions) => {
    requestOptions = options
    throw new Error("request intercepted")
  }) as typeof https.request

  try {
    const requester = createCodeNomadRequester({
      instanceId: "workspace",
      baseUrl: "https://127.0.0.1:443",
      callbackToken: "workspace-callback",
    })
    await assert.rejects(requester.requestVoid("/event"), /request intercepted/)
    assert.equal(requestOptions?.rejectUnauthorized, undefined)
    assert.equal(requestOptions?.agent, undefined)
  } finally {
    https.request = originalRequest
  }
})

test("plugin requests use the distinct callback capability", async () => {
  let authorization: string | undefined
  const server = createServer((request, response) => {
    authorization = request.headers.authorization
    response.writeHead(200, { Connection: "close" }).end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === "object")
    const requester = createCodeNomadRequester({
      instanceId: "workspace",
      baseUrl: `http://127.0.0.1:${address.port}`,
      callbackToken: "workspace-callback",
    })

    await requester.requestVoid("/event", { method: "POST" })

    assert.equal(authorization, "Bearer workspace-callback")
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
      server.closeAllConnections()
    })
  }
})

test("pre-aborted plugin requests reject without an unhandled request error", async () => {
  let requests = 0
  const server = createServer((_request, response) => {
    requests += 1
    response.writeHead(200, { Connection: "close" }).end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === "object")
    const requester = createCodeNomadRequester({
      instanceId: "workspace",
      baseUrl: `http://127.0.0.1:${address.port}`,
      callbackToken: "workspace-callback",
    })
    const controller = new AbortController()
    controller.abort()

    await assert.rejects(requester.requestVoid("/event", { signal: controller.signal }), { name: "AbortError" })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(requests, 0)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
      server.closeAllConnections()
    })
  }
})

test("plugin responses use null bodies when HTTP forbids response content", async () => {
  const server = createServer((request, response) => {
    const status = Number(new URL(request.url ?? "/", "http://localhost").pathname.slice(1)) || 200
    response.writeHead(status, { Connection: "close" }).end("ignored")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === "object")
    const requester = createCodeNomadRequester({
      instanceId: "workspace",
      baseUrl: `http://127.0.0.1:${address.port}`,
      callbackToken: "workspace-callback",
    })

    for (const status of [204, 205, 304]) {
      const response = await requester.fetch(`http://127.0.0.1:${address.port}/${status}`)
      assert.equal(response.status, status)
      assert.equal(response.body, null)
    }
    assert.equal(await requester.requestJson(`http://127.0.0.1:${address.port}/205`), undefined)
    const head = await requester.fetch(`http://127.0.0.1:${address.port}/200`, { method: "HEAD" })
    assert.equal(head.body, null)
    assert.equal(await requester.requestJson(`http://127.0.0.1:${address.port}/200`, { method: "HEAD" }), undefined)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
      server.closeAllConnections()
    })
  }
})
