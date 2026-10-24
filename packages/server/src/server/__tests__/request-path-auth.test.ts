import assert from "node:assert/strict"
import net from "node:net"
import test from "node:test"
import { startRemoteSurface } from "../../remote-control/test-support/surface"

// Writes a raw request line, so the target reaches the server exactly as written.
function send(target: string, requestTarget: string, options: { method?: string; cookie?: string; body?: string } = {}): Promise<{ status: number; head: string }> {
  const [hostname, port] = target.split(":")
  const body = options.body ?? ""
  const headers = [
    `${options.method ?? "GET"} ${requestTarget} HTTP/1.1`, `Host: ${target}`, "Connection: close",
    ...(options.cookie ? [`Cookie: ${options.cookie}`] : []),
    ...(body ? ["Content-Type: application/json", `Content-Length: ${Buffer.byteLength(body)}`] : []),
  ]
  return new Promise((resolve, reject) => {
    // "Connection: close" makes the server end the socket once it has replied.
    const socket = net.connect(Number(port), hostname, () => socket.write(`${headers.join("\r\n")}\r\n\r\n${body}`))
    let data = ""
    socket.on("data", (chunk) => { data += chunk })
    socket.on("close", () => resolve({ status: Number(data.split(" ")[1]), head: data.split("\r\n\r\n")[0] ?? "" }))
    socket.on("error", reject)
  })
}

test("local authentication judges the path the router routes, not the raw request target", async (t) => {
  const { local } = await startRemoteSurface(t)
  for (const target of [
    "/api/test/echo", "/%61pi/test/echo", "/%61%70%69/test/echo", "/%61pi/test/echo?x=1", "/api/test/echo;x",
    "/%73idecars/example/", "/%77orkspaces/example/instance/api/session",
  ]) {
    assert.equal((await send(local, target)).status, 401, target)
  }
  // The router would also route these, as "/api/test/echo" or not at all.
  for (const target of ["http://127.0.0.1/api/test/echo", "//api/test/echo", "/api/test/echo#x", "/%61pi/%E0%A4%A"]) {
    assert.equal((await send(local, target)).status, 400, target)
  }

  // Public routes stay public, and a session still reaches encoded paths.
  assert.equal((await send(local, "/%61pi/auth/status")).status, 200)
  const login = await send(local, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "codenomad", password: "local-password" }),
  })
  assert.equal(login.status, 200, login.head)
  const cookie = login.head.match(/^set-cookie: ([^;]+)/im)?.[1]
  assert.ok(cookie, login.head)
  assert.equal((await send(local, "/%61pi/test/echo", { cookie })).status, 200)
})
