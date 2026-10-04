import { createServer } from "node:http"

const [profile, token, managerPidText] = process.argv.slice(2)
const managerPid = Number(managerPidText)
let admitted = 0

const server = createServer(async (request, response) => {
  response.setHeader("content-type", "application/json")
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401).end(JSON.stringify({ error: "backend-auth-required" }))
    return
  }
  if (request.url === "/health") {
    response.end(JSON.stringify({ pid: process.pid, managerPid, profile, automationAvailable: false, nativeParent: "persistent-manager" }))
    return
  }
  if (request.url === "/admit" && request.method === "POST") {
    admitted += 1
    response.end(JSON.stringify({ backendPid: process.pid, admitted }))
    return
  }
  if (request.url === "/stop" && request.method === "POST") {
    response.end(JSON.stringify({ stopped: true }))
    server.close(() => process.exit(0))
    return
  }
  response.writeHead(404).end(JSON.stringify({ error: "not-found" }))
})

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port
  process.send?.({ type: "ready", url: `http://127.0.0.1:${port}`, pid: process.pid })
})

process.on("disconnect", () => server.close(() => process.exit(1)))
