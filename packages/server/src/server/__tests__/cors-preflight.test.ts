import assert from "node:assert/strict"
import http from "node:http"
import test from "node:test"
import { startRemoteSurface } from "../../remote-control/test-support/surface"

function preflight(target: string, origin: string, method: string): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  const [hostname, port] = target.split(":")
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname, port: Number(port), path: "/api/test/echo", method: "OPTIONS",
      headers: { origin, "access-control-request-method": method, "access-control-request-headers": "content-type" },
    }, (response) => {
      response.resume()
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers }))
    })
    request.on("error", reject)
    request.end()
  })
}

test("allowed cross-origin clients may preflight every method the API accepts", async (t) => {
  const { local } = await startRemoteSurface(t)
  for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]) {
    const response = await preflight(local, "http://localhost:3000", method)
    assert.equal(response.status, 204, method)
    assert.equal(response.headers["access-control-allow-origin"], "http://localhost:3000", method)
    assert.equal(response.headers["access-control-allow-credentials"], "true", method)
    assert.equal(response.headers["access-control-allow-methods"], "GET,HEAD,PUT,PATCH,POST,DELETE", method)
  }
  // Other origins still get no grant on a loopback listener.
  const foreign = await preflight(local, "https://foreign.example", "DELETE")
  assert.equal(foreign.headers["access-control-allow-origin"], undefined)
})
