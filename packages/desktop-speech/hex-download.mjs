import { open } from "node:fs/promises"
import { constants } from "node:fs"
import { HexFailure, writeChunk } from "./hex-files.mjs"

function allowedSource(url, initial) {
  return url.protocol === "https:" && !url.username && !url.password && !url.port &&
    (url.hostname === initial || (initial === "huggingface.co" &&
      (url.hostname.endsWith(".hf.co") || url.hostname.endsWith(".huggingface.co"))))
}

async function requestArtifact(artifact, offset, signal, request) {
  const headers = { "Accept-Encoding": "identity", ...(offset ? { Range: `bytes=${offset}-` } : {}) }
  let url = new URL(artifact.url)
  const host = url.hostname
  for (let redirects = 0; redirects <= 4; redirects++) {
    if (!allowedSource(url, host)) throw new HexFailure()
    const response = await request(url, { headers, redirect: "manual", signal, credentials: "omit" })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get("location")
    await response.body?.cancel()
    if (!location) break
    url = new URL(location, url)
  }
  throw new HexFailure()
}

export async function download(artifact, partial, offset, signal, progress, request) {
  const response = await requestArtifact(artifact, offset, signal, request)
  const expected = artifact.bytes - offset
  const length = response.headers.get("content-length")
  const encoding = response.headers.get("content-encoding")
  if (offset && (response.status === 200 || response.status === 416 ||
      (response.status === 206 && response.headers.get("content-range") !==
        `bytes ${offset}-${artifact.bytes - 1}/${artifact.bytes}`))) {
    await response.body?.cancel()
    throw new HexFailure("planChanged")
  }
  if (!response.body || response.status !== (offset ? 206 : 200) ||
      (length !== null && length !== String(expected)) || (encoding !== null && encoding !== "identity")) {
    await response.body?.cancel()
    throw new HexFailure()
  }
  const reader = response.body.getReader()
  let file
  let received = 0
  try {
    file = await open(partial, (offset ? constants.O_APPEND : constants.O_EXCL | constants.O_CREAT) |
      constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600)
    if ((await file.stat()).size !== offset) throw new HexFailure("planChanged")
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      if (received + value.byteLength > expected) throw new HexFailure()
      await writeChunk(file, value)
      received += value.byteLength
      progress(received)
    }
    if (received !== expected) throw new HexFailure()
    await file.sync()
  } finally {
    await reader.cancel().catch(() => {})
    await file?.close()
  }
}
