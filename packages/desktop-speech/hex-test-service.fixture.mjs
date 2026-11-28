import { createServer } from "node:http"
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { hexVersion, modelId } from "./hex-manifest.mjs"
const mode = process.argv[2]
const token = `hex_${"a".repeat(64)}`
const support = process.env.HEX_APPLICATION_SUPPORT_DIR
const server = createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) return res.writeHead(401).end()
  if (req.url === "/health") return res.end(JSON.stringify({ version: hexVersion, apiVersion: "2" }))
  if (req.url !== `/transcriptions?model=${modelId}&language=auto` ||
      req.method !== "POST" || req.headers["content-type"] !== "audio/wav") return res.writeHead(400).end()
  const blocks = []
  req.on("data", chunk => blocks.push(chunk))
  req.on("end", () => {
    const bytes = Buffer.concat(blocks)
    if (bytes.toString("ascii", 0, 4) !== "RIFF" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.HTTPS_PROXY) ||
        process.env.NO_PROXY || bytes.length !== Number(req.headers["content-length"])) return res.writeHead(400).end()
    if (bytes.length === 46) {
      if (mode === "warm-blocked") {
        writeFileSync(join(support, "warm-started"), String(process.pid))
        const timer = setInterval(() => {
          if (!existsSync(join(support, "warm-release"))) return
          clearInterval(timer)
          appendFileSync(join(support, "warmed"), `${process.pid}\n`)
          res.end(JSON.stringify({ transcript: "" }))
        }, 10)
        return
      }
      appendFileSync(join(support, "warmed"), `${process.pid}\n`)
      return res.end(JSON.stringify({ transcript: "" }))
    }
    if (mode === "blocked" || bytes.readInt16LE(44) === 42) {
      writeFileSync(join(support, "started"), String(process.pid))
      return
    }
    if (bytes.readInt16LE(44) === 43) return process.exit(9)
    if (bytes.readInt16LE(44) === 44) return res.end(JSON.stringify({ transcript: "é".repeat(32769) }))
    res.end(JSON.stringify({ transcript: "Bonjour, hello." }))
  })
})
process.stdin.resume()
process.stdin.on("end", () => {
  if (mode === "warm-blocked" && !existsSync(join(support, "warm-release"))) {
    const timer = setInterval(() => {
      if (!existsSync(join(support, "warm-release"))) return
      clearInterval(timer)
      process.exit(0)
    }, 10)
    writeFileSync(join(support, "closing"), "")
    return
  }
  if (mode !== "stuck") process.exit(0)
})
server.listen(0, "127.0.0.1", () => {
  mkdirSync(join(support, "logs"), { recursive: true })
  writeFileSync(join(support, "logs", `embedded-${process.pid}.ndjson`), "")
  const local = `http://127.0.0.1:${server.address().port}`
  const endpoint = { type: "ready", apiVersion: "2", pid: mode === "bad-pid" ? 0 : process.pid,
    url: mode === "redirect" ? local + "@example.org" : local, token }
  process.stdout.write(`${JSON.stringify(endpoint)}\n`)
})
