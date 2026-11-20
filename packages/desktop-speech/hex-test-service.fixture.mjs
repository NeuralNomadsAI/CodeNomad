import { createServer } from "node:http"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
const mode = process.argv[2]
const token = `hex_${"a".repeat(64)}`
const server = createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) return res.writeHead(401).end()
  if (req.url === "/health") return res.end(JSON.stringify({ version: "3.4.0", apiVersion: "2" }))
  if (req.url !== "/transcriptions?model=parakeet_v3&language=auto" ||
      req.method !== "POST" || req.headers["content-type"] !== "audio/wav") return res.writeHead(400).end()
  const blocks = []
  req.on("data", chunk => blocks.push(chunk))
  req.on("end", () => {
    const bytes = Buffer.concat(blocks)
    if (bytes.toString("ascii", 0, 4) !== "RIFF" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.HTTPS_PROXY) ||
        process.env.NO_PROXY || bytes.length !== Number(req.headers["content-length"])) return res.writeHead(400).end()
    if (mode === "blocked") {
      writeFileSync(join(process.env.HEX_APPLICATION_SUPPORT_DIR, "started"), String(process.pid))
      return
    }
    res.end(JSON.stringify({ transcript: "Bonjour, hello." }))
  })
})
server.listen(0, "127.0.0.1", () => {
  const local = `http://127.0.0.1:${server.address().port}`
  const endpoint = { type: "ready", apiVersion: "2", pid: mode === "bad-pid" ? 0 : process.pid,
    url: mode === "redirect" ? local + "@example.org" : local, token }
  process.stdout.write(`${JSON.stringify(endpoint)}\n`)
})
