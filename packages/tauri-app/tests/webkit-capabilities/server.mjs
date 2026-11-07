// Node launcher for the same acceptance page used by fixture.py (Windows hosts).
import { readFileSync } from "node:fs"
import { createServer } from "node:http"
const source = readFileSync(new URL("./fixture.py", import.meta.url), "utf8")
const page = source.match(/PAGE = b'''([\s\S]*?)'''/)[1].replaceAll("\\\\", "\\")
const popup = source.match(/POPUP = b'''([\s\S]*?)'''/)[1]
createServer((request, response) => {
  console.log(request.method, request.url)
  response.setHeader("Access-Control-Allow-Origin", "*")
  response.setHeader("Access-Control-Allow-Private-Network", "true")
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
  response.setHeader("Access-Control-Allow-Headers", "*")
  if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return }
  const route = new URL(request.url, "http://127.0.0.1:18741").pathname
  const download = route === "/download"
  const body = download ? "webkit-capabilities-download\n" : route === "/popup" ? popup : route === "/hold" ? "held" : page
  response.setHeader("Content-Type", download ? "application/octet-stream" : "text/html; charset=utf-8")
  if (download) response.setHeader("Content-Disposition", 'attachment; filename="capabilities-fixture.txt"')
  response.setHeader("Content-Length", Buffer.byteLength(body))
  response.end(body)
}).listen(18741, "127.0.0.1")
