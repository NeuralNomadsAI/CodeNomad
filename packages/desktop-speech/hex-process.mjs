import { spawn } from "node:child_process"
import { rm } from "node:fs/promises"
import { createServer } from "node:net"
import { request } from "node:http"
import { dirname, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { ensureDirectory, HexFailure } from "./hex-files.mjs"
import { hexVersion, modelId } from "./hex-manifest.mjs"

export const maxWavBytes = 44 + 16_000 * 2 * 120

export function validWav(wav) {
  return Buffer.isBuffer(wav) && wav.length > 44 && wav.length <= maxWavBytes &&
    wav.toString("ascii", 0, 4) === "RIFF" && wav.readUInt32LE(4) === wav.length - 8 &&
    wav.toString("ascii", 8, 16) === "WAVEfmt " && wav.readUInt32LE(16) === 16 &&
    wav.readUInt16LE(20) === 1 && wav.readUInt16LE(22) === 1 && wav.readUInt32LE(24) === 16_000 &&
    wav.readUInt32LE(28) === 32_000 && wav.readUInt16LE(32) === 2 && wav.readUInt16LE(34) === 16 &&
    wav.toString("ascii", 36, 40) === "data" && wav.readUInt32LE(40) === wav.length - 44 && wav.length % 2 === 0
}

export async function withChild(executable, args, options, signal, run, stopTree) {
  signal.throwIfAborted()
  const child = spawn(executable, args, { ...options, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] })
  const startedBy = new Date()
  const closed = new Promise(resolve => {
    child.on("error", () => {})
    child.once("close", code => resolve(code))
  })
  child.stdin.on("error", () => {})
  child.stdout.on("error", () => {})
  let stopping
  const stop = () => stopping ??= (async () => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        if (child.pid && options.detached) {
          try { process.kill(-child.pid, "SIGKILL") } catch (error) { if (error.code !== "ESRCH") throw error }
        } else if (child.pid && stopTree) {
          child.stdin.end()
          // Hex normally exits when the lease closes. Inventory is for force-stop.
          await Promise.race([closed, delay(350, undefined, { ref: false })])
          if (child.exitCode === null && child.signalCode === null) await stopTree(child.pid, startedBy)
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      }
    }
    child.stdin.destroy()
  })()
  const abort = () => { void stop().catch(() => {}) }
  signal.addEventListener("abort", abort, { once: true })
  try {
    signal.throwIfAborted()
    return await run(child, closed)
  } finally {
    signal.removeEventListener("abort", abort)
    try { await stop() } finally { await closed }
  }
}

async function readBounded(stream, limit, line = false) {
  const parts = []
  let length = 0
  // Do not destroy the child's stdout when the first line finishes; the child owns its stdout.
  for await (const block of stream.iterator({ destroyOnReturn: false })) {
    const end = line ? block.indexOf(10) : -1
    const bytes = end >= 0 ? block.subarray(0, end) : block
    length += bytes.length
    if (length > limit) throw new HexFailure()
    parts.push(bytes)
    if (end >= 0) return Buffer.concat(parts, length).toString("utf8")
  }
  if (line) throw new HexFailure()
  return Buffer.concat(parts, length).toString("utf8")
}

export async function command(executable, args, signal) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
  return withChild(executable, args, {}, deadline, async (child, closed) => {
    child.stdin.end()
    const output = await readBounded(child.stdout, 4096)
    deadline.throwIfAborted()
    if (await closed !== 0) throw new HexFailure()
    return output.trim()
  })
}

function localRequest(port, token, path, signal, wav) {
  return new Promise((resolve, reject) => {
    const headers = { Authorization: `Bearer ${token}`, Connection: "close" }
    if (wav) Object.assign(headers, { "Content-Type": "audio/wav", "Content-Length": wav.length })
    const req = request({ host: "127.0.0.1", port, path, method: wav ? "POST" : "GET", headers, signal, agent: false }, res => {
      if (res.statusCode !== 200) { res.destroy(); reject(new HexFailure()); return }
      void readBounded(res, 128 * 1024).then(text => resolve(JSON.parse(text))).catch(reject)
    })
    req.on("error", reject)
    req.end(wav)
  })
}

async function denyOutbound(action) {
  // The pinned Hex downloader honors HTTPS_PROXY before OS proxy discovery. Keep a
  // rejecting endpoint reserved for the whole process so even a missing VAD cannot download.
  const proxy = createServer(socket => socket.destroy())
  await new Promise((resolve, reject) => {
    proxy.once("error", reject)
    proxy.listen(0, "127.0.0.1", resolve)
  })
  try { return await action(`http://127.0.0.1:${proxy.address().port}`) }
  finally { await new Promise(resolve => proxy.close(resolve)) }
}

async function withHex({ executable, support }, signal, args, run, resident = false, stopTree) {
  return denyOutbound(async proxy => {
    const env = Object.fromEntries(["HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "SystemDrive", "TEMP", "TMP", "TMPDIR"]
      .filter(key => process.env[key]).map(key => [key, process.env[key]]))
    Object.assign(env, {
      HEX_APPLICATION_SUPPORT_DIR: support, HTTPS_PROXY: proxy, HTTP_PROXY: proxy, ALL_PROXY: proxy,
      RUST_LOG: "error",
    })
    const startup = AbortSignal.timeout(10_000)
    const startAbort = new AbortController()
    const startLimit = () => startAbort.abort()
    startup.addEventListener("abort", startLimit, { once: true })
    let pid
    try {
      return await withChild(executable, args, { cwd: dirname(executable), env, detached: resident && process.platform !== "win32" },
        AbortSignal.any([signal, startAbort.signal]), async child => {
        pid = child.pid
        const ready = JSON.parse(await readBounded(child.stdout, 2048, true))
        const match = typeof ready?.url === "string" && /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(ready.url)
        const port = Number(match?.[1])
        if (!match || port > 65_535 || ready.type !== "ready" || ready.apiVersion !== "2" ||
            ready.pid !== child.pid || typeof ready.token !== "string" ||
            !/^hex_[0-9a-f]{64}$/.test(ready.token)) throw new HexFailure()
        child.stdout.resume()
        const health = await localRequest(port, ready.token, "/health", AbortSignal.any([signal, startup]))
        if (health?.apiVersion !== "2" || health.version !== hexVersion) throw new HexFailure()
        startup.removeEventListener("abort", startLimit)
        return run((path, wav, limit = signal) => localRequest(port, ready.token, path,
          AbortSignal.any([signal, limit]), wav), child)
      }, stopTree)
    } finally {
      // Hex deletes this lease log on graceful exit; also remove it after forced termination.
      try {
        const logs = join(support, "logs")
        if (pid && ensureDirectory(logs)) await rm(join(logs, `embedded-${pid}.ndjson`), { force: true })
      } catch { /* No transcript or WAV is persisted by CodeNomad. */ }
    }
  })
}

export function checkHex(installation, signal) {
  return withHex(installation, signal, ["service", "--embedded"], async request => {
    const models = await request("/models?language=auto")
    if (!Array.isArray(models) || !models.some(model =>
      model?.id === modelId && model.installed === true && model.verified === true)) throw new HexFailure()
  })
}

// Hex loads on transcription, not /health. One zero PCM sample loads the
// verified model without touching the microphone or a model-download endpoint.
const silence = Buffer.from("524946462600000057415645666d74201000000001000100803e0000007d00000200100064617461020000000000", "hex")

async function transcribe(request, wav) {
  if (!validWav(wav)) throw new HexFailure()
  const result = await request(`/transcriptions?model=${modelId}&language=auto`, wav)
  if (typeof result?.transcript !== "string" || Buffer.byteLength(result.transcript) > 64 * 1024) throw new HexFailure()
  return result.transcript
}

export function createHexService({ args = ["service", "--embedded"], idleMs = 180_000, isSelected, stopTree } = {}) {
  let current
  async function stop() {
    const entry = current
    entry?.retire()
    await entry?.closed
  }

  function start(installation, key) {
    const abort = new AbortController()
    const retired = new AbortController()
    const { promise: ready, resolve, reject } = Promise.withResolvers()
    let warming
    const retire = () => {
      if (retired.signal.aborted) return
      retired.abort()
      // Closing stdin mid-load makes Hex's own shutdown timer look like a
      // Windows GPU crash. Drain only the bounded synthetic request.
      if (process.platform === "win32" && warming) {
        void Promise.race([warming.catch(() => {}), delay(2_000, undefined, { ref: false })])
          .then(() => abort.abort())
      } else abort.abort()
    }
    const entry = { key, signal: AbortSignal.any([abort.signal, retired.signal]), retire, ready, idle: undefined }
    void ready.catch(() => {})
    const selected = isSelected && setInterval(() => {
      if (!isSelected()) retire()
    }, 1_000).unref()
    entry.closed = withHex(installation, abort.signal, args, async (request, child) => {
      child.once("exit", () => abort.abort())
      warming = transcribe((path, wav) => request(path, wav, AbortSignal.timeout(120_000)), silence)
      try { await warming } finally { warming = undefined }
      abort.signal.throwIfAborted()
      resolve(request)
      await new Promise(resolve => abort.signal.addEventListener("abort", resolve, { once: true }))
    }, true, stopTree).catch(reject).finally(() => {
      abort.abort()
      if (current === entry) current = undefined
      clearInterval(selected)
      clearTimeout(entry.idle)
    })
    return entry
  }

  async function use(installation, key, signal, run) {
    if (current && (current.key !== key || current.signal.aborted)) await stop()
    signal.throwIfAborted()
    if (isSelected && !isSelected()) throw new HexFailure("unavailable")
    const entry = current ??= start(installation, key)
    clearTimeout(entry.idle)
    let uploaded = false
    const { promise: stopped, reject } = Promise.withResolvers()
    const onStop = () => reject(new HexFailure())
    const cancel = () => {
      // A cancelled recording owns no audio in Hex until the POST. Let its
      // synthetic prewarm finish so a stopped GPU load isn't seen as a crash.
      if (uploaded) entry.retire()
      onStop()
    }
    signal.addEventListener("abort", cancel, { once: true })
    entry.signal.addEventListener("abort", onStop, { once: true })
    try {
      const text = await Promise.race([stopped, run(async (wav, check) => {
        const request = await entry.ready
        entry.signal.throwIfAborted()
        signal.throwIfAborted()
        if (isSelected && !isSelected()) throw new HexFailure("unavailable")
        check?.()
        uploaded = true
        return transcribe(request, wav)
      })])
      entry.signal.throwIfAborted()
      if (isSelected && !isSelected()) throw new HexFailure("unavailable")
      return text
    } catch (error) {
      if (!signal.aborted || uploaded) entry.retire()
      throw error
    } finally {
      signal.removeEventListener("abort", cancel)
      entry.signal.removeEventListener("abort", onStop)
      if (entry.signal.aborted) await entry.closed
      else entry.idle = setTimeout(entry.retire, idleMs).unref()
    }
  }
  return { use, stop }
}
