import assert from "node:assert/strict"
import { test } from "node:test"
import type { ChildProcess } from "node:child_process"
import { dispatchNativeRequest, NATIVE_REQUEST_PREFIX, parseNativeRequest } from "./native-request"

test("native requests are validated and answered on the child stdin", async () => {
  const request = parseNativeRequest(`${NATIVE_REQUEST_PREFIX}{"v":1,"id":"request-1","method":"developer.status","deadline":${Date.now() + 10_000}}`)
  assert.ok(request)
  assert.equal(parseNativeRequest(`${NATIVE_REQUEST_PREFIX}{"v":2}`), undefined)

  let written = ""
  const child = {
    stdin: {
      writable: true,
      write(chunk: string) {
        written += chunk
        return true
      },
    },
  } as unknown as ChildProcess
  await dispatchNativeRequest(child, request, async (method, params) => ({ method, params }), () => true)

  assert.deepEqual(JSON.parse(written.slice("CODENOMAD_NATIVE_RESPONSE:".length)), {
    v: 1,
    id: "request-1",
    ok: true,
    result: { method: "developer.status" },
  })
})

test("native response ignores a child stdin closed during dispatch", async () => {
  const request = parseNativeRequest(`${NATIVE_REQUEST_PREFIX}{"v":1,"id":"request-2","method":"developer.status","deadline":${Date.now() + 10_000}}`)
  assert.ok(request)
  const child = {
    stdin: {
      writable: true,
      write() {
        throw Object.assign(new Error("closed"), { code: "EPIPE" })
      },
    },
  } as unknown as ChildProcess
  await dispatchNativeRequest(child, request, async () => ({}), () => true)
})
