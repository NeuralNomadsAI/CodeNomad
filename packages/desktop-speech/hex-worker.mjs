// Private Tauri child for Hex discovery and preparation.
import { createHexCache } from "./hex-cache.mjs"
import { HexFailure } from "./hex-files.mjs"

const [, , action, root, arg] = process.argv
const cache = createHexCache(root)
const send = value => new Promise((resolve, reject) => {
  process.stdout.write(`${JSON.stringify(value)}\n`, error => error ? reject(error) : resolve())
})
const abort = new AbortController()
process.stdout.on("error", () => abort.abort())
process.stdin.on("end", () => abort.abort())
process.stdin.on("error", () => abort.abort())

try {
  if (action === "read") {
    await send({ value: cache.capabilities() })
  } else if (action === "installation") {
    process.stdin.resume()
    await send({ value: await cache.nativeInstallation(abort.signal) })
  } else if (action === "prepare") {
    const readable = await new Promise(resolve => {
      process.stdin.once("readable", () => resolve(process.stdin.read(1)?.[0] === 1))
      process.stdin.once("end", () => resolve(false))
      abort.signal.addEventListener("abort", () => resolve(false), { once: true })
    })
    if (!readable) throw new HexFailure()
    process.stdin.resume()
    let lastProgress = 0
    await cache.prepare(arg, abort.signal, value => {
      if (value.state === "downloading" && Date.now() - lastProgress < 100) return
      lastProgress = Date.now()
      void send({ progress: value }).catch(() => abort.abort())
    })
    await send({ value: null })
  } else {
    throw new HexFailure()
  }
} catch (error) {
  await send({ error: error instanceof HexFailure ? error.code : "failed" }).catch(() => {})
} finally {
  process.stdin.destroy()
}
