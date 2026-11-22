import { createHash } from "node:crypto"
import { chmodSync, realpathSync, renameSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { arch, homedir, platform, release } from "node:os"
import { delimiter, dirname, isAbsolute, join } from "node:path"
import { artifactReceipt, candidateDirectory, cleanCopy, ensureDirectory, fileInfo, hashFile, HexFailure, publish, readReceipt } from "./hex-files.mjs"
import { download } from "./hex-download.mjs"
import { hexArtifacts, hexVersion, modelId } from "./hex-manifest.mjs"
import { macExecutable, materializeMac, macCandidates, verifyMac } from "./hex-macos.mjs"
import { checkHex, createHexService } from "./hex-process.mjs"

function* existing(name, candidates, bytes) {
  for (const directory of candidates.filter(Boolean)) {
    const path = join(directory, name)
    try {
      const info = candidateDirectory(path)
      if (info?.bytes === bytes) yield { path, ...info }
    } catch { /* Leave external files and directories untouched. */ }
  }
}

function linuxDataHome() {
  const xdg = process.env.XDG_DATA_HOME
  return xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "share")
}

function* reuseFiles(component, artifact, platform) {
  if (component === "engine") {
    if (platform === "darwin") {
      yield* macCandidates()
      return
    }
    const { APPDATA, LOCALAPPDATA, PATH } = process.env
    const versioned = [APPDATA, LOCALAPPDATA].filter(Boolean).map(base => join(base, "hex", "versions", hexVersion))
    yield* existing(artifact.filename, [
      ...versioned, platform === "linux" && join(homedir(), ".local", "bin"),
      platform === "linux" && "/usr/bin", platform === "linux" && "/usr/local/bin",
      ...(PATH ?? "").split(delimiter, 64).filter(isAbsolute),
      platform === "linux" && join(linuxDataHome(), "hex", "versions", hexVersion),
    ], artifact.bytes)
    return
  }
  const { APPDATA, LOCALAPPDATA, HF_HUB_CACHE, HF_HOME } = process.env
  const appData = platform === "win32" ? [LOCALAPPDATA, APPDATA]
    : [platform === "darwin" ? join(homedir(), "Library", "Application Support")
      : linuxDataHome()]
  const hub = HF_HUB_CACHE || join(HF_HOME || join(homedir(), ".cache", "huggingface"), "hub")
  const repository = join(hub, `models--handy-computer--${artifact.repository}`)
  const hexModels = appData.filter(Boolean).map(base => join(base, "hex", "models"))
  yield* existing(artifact.filename, [...hexModels, join(repository, "snapshots", artifact.revision)], artifact.bytes)
  yield* existing(artifact.sha256, [join(repository, "blobs")], artifact.bytes)
}

// The loopback listener is an OS-released, cross-process lock, with no stale lease to steal.
// The path's canonical spelling makes Electron/Tauri and profiles contend on the same cache.
async function lockCache(root, action) {
  let canonical = realpathSync(root)
  if (platform() === "win32") canonical = canonical.toLowerCase()
  const port = 16_384 + (createHash("sha256").update(canonical).digest().readUInt16BE(0) % 16_384)
  const lock = createServer(socket => socket.destroy())
  await new Promise((resolve, reject) => {
    lock.once("error", error => reject(new HexFailure(error.code === "EADDRINUSE" ? "busy" : "failed")))
    lock.listen({ port, host: "127.0.0.1", exclusive: true }, resolve)
  })
  try { return await action() } finally {
    await new Promise(resolve => lock.close(resolve))
  }
}

export function createHexCache(root, {
  host = platform(),
  artifacts = hexArtifacts(host, arch(), release(), host === "linux" ? process.report.getReport().header.glibcVersionRuntime : undefined),
  reuse = (component, artifact) => reuseFiles(component, artifact, host),
  request = fetch,
  probe = checkHex,
  isSelected,
  stopTree,
} = {}) {
  const service = createHexService({ isSelected, stopTree })
  const versionDir = join(root, `hex-${hexVersion}`)
  const engineDir = join(versionDir, `${host}-${arch()}`)
  const models = join(versionDir, "models")
  function directories(create = false) {
    const rootExists = ensureDirectory(root, create) && ensureDirectory(versionDir, create)
    if (!rootExists) return false
    ensureDirectory(engineDir, create)
    ensureDirectory(models, create)
    return true
  }

  function inspect() {
    if (!artifacts) return
    const exists = directories()
    const parts = Object.entries(artifacts).map(([component, artifact]) => {
      const mac = component === "engine" && host === "darwin"
      const path = join(component === "engine" ? engineDir : models, artifact.filename)
      const file = exists && fileInfo(path)
      const partial = `${path}.part`
      const retained = exists && fileInfo(partial)
      const invalid = `${path}.invalid.json`
      const materialized = mac && exists && macExecutable(engineDir)
      const receipt = exists && readReceipt(`${path}.verified.json`)
      const ready = mac ? !!materialized :
        !!file && file.bytes === artifact.bytes && receipt?.sha256 === artifact.sha256 && receipt.stamp === file.stamp
      const candidates = ready ? [] : [...new Map([...reuse(component, artifact)].map(source => [source.path, source])).values()]
      const sourceId = createHash("sha256").update(JSON.stringify(
        candidates.map(source => [source.path, source.stamp]),
      )).digest("hex")
      const sources = exists && readReceipt(invalid)?.sources === sourceId ? [] : candidates
      const offset = retained && retained.bytes <= artifact.bytes ? retained.bytes : 0
      const bytes = ready || file?.bytes === artifact.bytes || sources.length ? 0 : artifact.bytes - offset
      return { component, artifact, mac, path, partial, retained, offset, file, ready, sources, sourceId, invalid,
        downloadBytes: bytes, executable: materialized?.path || path, stamp: materialized?.stamp || file?.stamp }
    })
    const id = createHash("sha256").update(JSON.stringify(parts.map(p => [
      p.component, p.artifact.url, p.artifact.sha256, p.artifact.bytes, p.ready,
      p.stamp, p.file?.stamp, p.retained?.stamp, p.sources.length ? p.sourceId : null,
    ]))).digest("hex")
    const receipt = exists && readReceipt(join(engineDir, "ready.json"))
    const missing = parts.filter(p => !p.ready).map(({ component, downloadBytes }) => ({ component, downloadBytes }))
    const ready = !missing.length && receipt?.plan === id
    return { parts, ready, plan: { id, missing: ready || missing.length ? missing : [{ component: "engine", downloadBytes: 0 }] } }
  }

  function capabilities() {
    try {
      const current = inspect()
      return current ? { state: current.ready ? "ready" : "needsPreparation", plan: current.plan } :
        { state: "unavailable" }
    } catch { return { state: "unavailable" } }
  }

  async function prepare(planId, signal, progress) {
    if (!artifacts) throw new HexFailure("unavailable")
    signal.throwIfAborted()
    directories(true)
    await lockCache(root, async () => {
      const { parts, plan } = inspect()
      if (plan.id !== planId) throw new HexFailure("planChanged")
      const verified = new Set()
      let changed = false
      for (const part of parts) {
        if (part.ready || (part.file?.bytes !== part.artifact.bytes && !part.sources.length)) continue
        progress({ state: "verifying" })
        if (await verifyLocal(part, signal)) {
          await seal(part, signal)
          verified.add(part)
        } else {
          publish(part.invalid, JSON.stringify({ sources: part.sourceId }))
          changed = true
        }
      }
      if (changed) throw new HexFailure("planChanged")
      let downloaded = 0
      for (const part of parts) {
        signal.throwIfAborted()
        if (part.ready || verified.has(part)) continue
        const { artifact, path, partial, offset } = part
        if (part.retained && !offset) rmSync(partial)
        if (offset < artifact.bytes) {
          progress({ state: "downloading", downloadedBytes: downloaded })
          try {
            await download(artifact, partial, offset, signal, bytes =>
              progress({ state: "downloading", downloadedBytes: downloaded + bytes }), request)
          } catch (error) {
            if (error instanceof HexFailure && error.code === "planChanged" && offset) rmSync(partial, { force: true })
            throw error
          }
          downloaded += artifact.bytes - offset
        }
        progress({ state: "verifying" })
        if (!await hashFile(partial, artifact, signal)) {
          rmSync(partial)
          throw new HexFailure("planChanged")
        }
        signal.throwIfAborted()
        renameSync(partial, path)
        await seal(part, signal)
      }
      signal.throwIfAborted()
      const candidate = inspect()
      const installation = candidate && getInstallation(candidate)
      progress({ state: "verifying" })
      await service.stop()
      await probe(installation, signal)
      signal.throwIfAborted()
      if (inspect()?.plan.id !== candidate.plan.id) throw new HexFailure("planChanged")
      publish(join(engineDir, "ready.json"), JSON.stringify({ plan: candidate.plan.id }))
    })
  }

  async function seal({ component, artifact, path, mac, partial, retained }, signal) {
    signal.throwIfAborted()
    if (component === "engine" && host !== "win32" && !mac) chmodSync(path, 0o700)
    if (mac && !macExecutable(engineDir) && !await materializeMac(engineDir, { archive: path }, signal)) throw new HexFailure()
    if (!mac) artifactReceipt(path, artifact)
    if (retained) rmSync(partial, { force: true })
  }

  async function verifyLocal({ path, file, artifact, sources }, signal) {
    signal.throwIfAborted()
    if (file?.bytes === artifact.bytes) {
      if (await hashFile(path, artifact, signal)) return true
      rmSync(path)
    }
    for (const source of sources) {
      signal.throwIfAborted()
      if (source.app) {
        if (await materializeMac(engineDir, source, signal)) return true
        continue
      }
      if (await cleanCopy(path, async temp => {
        let matches
        try {
          if (fileInfo(source.path)?.stamp !== source.stamp) return false
          matches = await hashFile(source.path, artifact, signal, temp)
        } catch (error) {
          if (error.path === source.path && ["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EPERM"].includes(error.code)) return false
          if (error instanceof HexFailure) return false
          throw error
        }
        if (!matches) return false
        signal.throwIfAborted()
        renameSync(temp, path)
        return true
      })) return true
    }
    return false
  }

  function getInstallation(current) {
    if (current.parts.some(part => !part.ready)) throw new HexFailure("unavailable")
    return { executable: current.parts.find(part => part.component === "engine").executable, support: versionDir }
  }

  async function verified(signal) {
    const current = inspect()
    if (!current?.ready) throw new HexFailure("unavailable")
    if (host === "darwin" && !await verifyMac(join(engineDir, "Hex.app"), signal)) throw new HexFailure("unavailable")
    const latest = inspect()
    if (!latest?.ready || latest.plan.id !== current.plan.id) throw new HexFailure("unavailable")
    return current
  }

  async function nativeInstallation(signal) {
    const current = await verified(signal)
    const installation = getInstallation(current)
    const files = [join(engineDir, "ready.json"), ...current.parts.flatMap(part => part.mac
      ? [part.executable, join(dirname(dirname(part.executable)), "Info.plist"),
        join(engineDir, "mac-app.verified.json"), ...(part.file ? [part.path] : [])]
      : [part.path, `${part.path}.verified.json`])]
    const directories = [root, versionDir, engineDir, models]
    if (host === "darwin") {
      const macos = dirname(installation.executable)
      directories.push(macos, dirname(macos), dirname(dirname(macos)))
    }
    return { ...installation, key: current.plan.id, version: hexVersion, model: modelId, files, directories }
  }

  async function use(signal, run) {
    let current
    try { current = await verified(signal) }
    catch (error) { if (!signal.aborted) await service.stop(); throw error }
    return service.use(getInstallation(current), current.plan.id, signal, transcribe => run(wav => transcribe(wav, () => {
      const latest = inspect()
      if (!latest?.ready || latest.plan.id !== current.plan.id) throw new HexFailure("unavailable")
    })))
  }
  return { capabilities, prepare, nativeInstallation, use, stop: service.stop }
}
