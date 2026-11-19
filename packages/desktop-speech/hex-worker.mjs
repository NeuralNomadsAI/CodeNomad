// Private Tauri child. Its stdin stays open as the host lease, including during inference.
import { createHexCache } from "./hex-cache.mjs"
import { HexFailure } from "./hex-files.mjs"
import { maxWavBytes } from "./hex-process.mjs"

const [, , action, root, arg] = process.argv
const cache = createHexCache(root)
const send = value => new Promise((resolve, reject) => {
  process.stdout.write(`${JSON.stringify(value)}\n`, error => error ? reject(error) : resolve())
})
const abort = new AbortController()
process.stdout.on("error", () => abort.abort())
process.stdin.on("end", () => abort.abort())
process.stdin.on("error", () => abort.abort())

async function input(length) {
  if (!Number.isSafeInteger(length) || length < 1 || length > maxWavBytes) throw new HexFailure()
  const value = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const block = process.stdin.read(Math.min(length - offset, 65_536))
    if (block) {
      block.copy(value, offset)
      offset += block.length
    } else await new Promise((resolve, reject) => {
      const onAbort = () => { clear(); reject(new HexFailure()) }
      const onRead = () => { clear(); resolve() }
      const clear = () => {
        process.stdin.removeListener("readable", onRead)
        abort.signal.removeEventListener("abort", onAbort)
      }
      abort.signal.throwIfAborted()
      process.stdin.once("readable", onRead)
      abort.signal.addEventListener("abort", onAbort, { once: true })
    })
  }
  process.stdin.resume()
  return value
}

try {
  if (action === "read") {
    await send({ value: cache.capabilities() })
  } else if (action === "prepare") {
    if ((await input(1))[0] !== 1) throw new HexFailure()
    let lastProgress = 0
    await cache.prepare(arg, abort.signal, value => {
      if (value.state === "downloading" && Date.now() - lastProgress < 100) return
      lastProgress = Date.now()
      void send({ progress: value }).catch(() => abort.abort())
    })
    await send({ value: null })
  } else if (action === "transcribe") {
    const wav = await input(Number(arg))
    await send({ value: await cache.transcribe(wav, abort.signal) })
  } else {
    throw new HexFailure()
  }
} catch (error) {
  await send({ error: error instanceof HexFailure ? error.code : "failed" }).catch(() => {})
} finally {
  process.stdin.destroy()
}
