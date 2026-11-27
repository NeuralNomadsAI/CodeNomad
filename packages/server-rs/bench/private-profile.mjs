// Canonical path fence for the headless comparison bench. Refuse before spawning.
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { lstat, readFile, readlink, realpath, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const below = (root, file) => {
  const relative = path.relative(root, file)
  return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)
}
// The account's own profile (os.userInfo asks the system), even when HOME/USERPROFILE point elsewhere.
const accountHome = os.userInfo().homedir
const unsafeRoots = [...new Set([os.homedir(), accountHome])]

const LOCAL_WINDOWS_DRIVE_TYPES = new Set(["Fixed", "Ram"])
const LOCAL_LINUX_FS_TYPES = new Set([
  "ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "tmpfs", "ramfs",
  "overlay", "overlayfs", "f2fs", "jfs", "reiserfs", "vfat", "msdos",
  "exfat", "ntfs", "ntfs3", "apfs", "hfs", "hfsplus", "squashfs",
  "erofs", "bcachefs", "nilfs2", "udf", "rootfs",
])
const LOCAL_DARWIN_FS_TYPES = new Set(["apfs", "hfs", "ufs", "msdos", "exfat", "ntfs", "tmpfs"])
const windowsDriveTypeCache = new Map()
const OPENCODE_BIN_NAMES = ["opencode2", "opencode"]

export async function resolveSystemPowerShell(env = process.env) {
  const sysRootKey = Object.keys(env).find(key => key.toLowerCase() === "systemroot")
  const windirKey = Object.keys(env).find(key => key.toLowerCase() === "windir")
  const rawRoot = (sysRootKey ? env[sysRootKey] : undefined) || (windirKey ? env[windirKey] : undefined) || "C:\\Windows"
  assert(
    typeof rawRoot === "string" && isDriveQualifiedWindowsPath(rawRoot),
    `Refused: SystemRoot/WINDIR must be a drive-qualified local Windows path (${rawRoot})`,
  )
  const forbidden = await forbiddenHomeRoots({}, { accountHomeOnly: true })
  const normalizedRoot = path.resolve(rawRoot)
  assert(!forbidden.some(home => within(home, normalizedRoot)), `Refused: SystemRoot/WINDIR is inside the user's home (${rawRoot})`)
  const resolvedRoot = await canonical(normalizedRoot)
  assert(isDriveQualifiedWindowsPath(resolvedRoot), `Refused: SystemRoot/WINDIR resolves to a non-local path (${resolvedRoot})`)
  assert(!forbidden.some(home => within(home, resolvedRoot)), `Refused: SystemRoot/WINDIR resolves inside the user's home (${resolvedRoot})`)
  const exePath = path.join(resolvedRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  const resolvedExe = await canonical(exePath)
  assert(isDriveQualifiedWindowsPath(resolvedExe), `Refused: PowerShell resolves to a non-local path (${resolvedExe})`)
  assert(!forbidden.some(home => within(home, resolvedExe)), `Refused: PowerShell resolves inside the user's home (${resolvedExe})`)
  assert(within(resolvedRoot, resolvedExe), `Refused: PowerShell escapes SystemRoot (${resolvedExe})`)
  const info = await stat(resolvedExe).catch(() => null)
  assert(info?.isFile(), `Refused: Windows PowerShell executable not found (${resolvedExe})`)
  return resolvedExe
}

export async function outsideUserHome(directory) {
  const resolved = await realpath(directory)
  assert(!unsafeRoots.some(home => below(home, directory) || below(home, resolved)), "Bench profile must be outside the user's home")
  return resolved
}

const isDriveQualifiedWindowsPath = value => /^[A-Za-z]:[\\/]/.test(value)

async function forbiddenHomeRoots(env = process.env, { accountHomeOnly = false } = {}) {
  const baseRoots = accountHomeOnly ? [accountHome] : unsafeRoots
  const candidates = [...baseRoots, env?.USERPROFILE, env?.HOME]
    .filter(value => typeof value === "string" && path.isAbsolute(value))
    .map(value => path.resolve(value))
  const roots = [...new Set(candidates)]
  const canonicalRoots = await Promise.all(roots.map(home => canonical(home).catch(() => home)))
  return [...new Set([...roots, ...canonicalRoots])]
}

async function queryWindowsDriveTypes(letters, options = {}) {
  const missing = [...new Set(letters.map(l => l.toUpperCase()))].filter(l => !windowsDriveTypeCache.has(l))
  if (missing.length > 0) {
    for (const letter of missing) assert(/^[A-Z]$/.test(letter), `Invalid Windows drive letter: ${letter}`)
    const powershell = await resolveSystemPowerShell(options.systemEnv ?? process.env)
    const list = missing.map(l => `'${l}'`).join(",")
    const { stdout } = await execFileAsync(
      powershell,
      ["-NoProfile", "-NonInteractive", "-Command", `@(${list}) | ForEach-Object { "$_=$([System.IO.DriveInfo]::new($_).DriveType)" }`],
      { windowsHide: true, timeout: 20_000 },
    )
    for (const line of String(stdout).trim().split(/\r?\n/)) {
      const match = /^([A-Z])=([A-Za-z]+)$/.exec(line.trim())
      if (match) windowsDriveTypeCache.set(match[1], match[2])
    }
  }
  return Object.fromEntries(letters.map(l => [l.toUpperCase(), windowsDriveTypeCache.get(l.toUpperCase()) ?? "Unknown"]))
}

function decodeMountEscape(raw) {
  return raw.replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(Number.parseInt(oct, 8)))
}

async function detectLinuxMountFsType(targetPath, readMounts = () => readFile("/proc/mounts", "utf8")) {
  const content = await readMounts()
  let bestMount = ""
  let bestFsType = null
  for (const line of String(content).split(/\r?\n/)) {
    if (!line) continue
    const parts = line.split(" ")
    if (parts.length < 3) continue
    const mountPoint = decodeMountEscape(parts[1])
    if (within(mountPoint, targetPath) && mountPoint.length >= bestMount.length) {
      bestMount = mountPoint
      bestFsType = parts[2].toLowerCase()
    }
  }
  return bestFsType
}

async function detectDarwinMountMeta(targetPath, readDarwinMounts) {
  const content = readDarwinMounts
    ? await readDarwinMounts()
    : (await execFileAsync("/sbin/mount", [], { timeout: 5_000 })).stdout
  let bestMount = ""
  let bestMeta = null
  for (const line of String(content).split(/\r?\n/)) {
    const match = /\son\s(.+?)\s\(([^)]+)\)$/.exec(line)
    if (!match) continue
    const [, mountPoint, meta] = match
    if (within(mountPoint, targetPath) && mountPoint.length >= bestMount.length) {
      bestMount = mountPoint
      bestMeta = meta.split(",").map(part => part.trim().toLowerCase())
    }
  }
  return bestMeta
}

async function assertLocalVolume(targetPath, options = {}) {
  const platform = options.platform ?? process.platform
  if (platform === "win32") {
    assert(isDriveQualifiedWindowsPath(targetPath), `Refused: OpenCode executable must be a drive-qualified local path (${targetPath})`)
    const letter = targetPath[0].toUpperCase()
    const driveType = options.probeDriveType
      ? await options.probeDriveType(letter)
      : (await queryWindowsDriveTypes([letter], options))[letter]
    if (!LOCAL_WINDOWS_DRIVE_TYPES.has(driveType)) {
      throw new assert.AssertionError({
        message: `Refused: OpenCode executable must reside on a local volume (${targetPath}, drive ${letter}: is ${driveType})`,
      })
    }
    return
  }
  if (platform === "linux" || options.readMounts) {
    let fsType
    try {
      fsType = await detectLinuxMountFsType(targetPath, options.readMounts)
    } catch (error) {
      throw new assert.AssertionError({
        message: `Refused: OpenCode executable must reside on a local volume (${targetPath}, mount check failed: ${error?.message ?? error})`,
      })
    }
    if (!fsType || !LOCAL_LINUX_FS_TYPES.has(fsType)) {
      throw new assert.AssertionError({
        message: `Refused: OpenCode executable must reside on a local volume (${targetPath}, filesystem is ${fsType ?? "unknown"})`,
      })
    }
    return
  }
  if (platform === "darwin" || options.readDarwinMounts) {
    let meta
    try {
      meta = await detectDarwinMountMeta(targetPath, options.readDarwinMounts)
    } catch (error) {
      throw new assert.AssertionError({
        message: `Refused: OpenCode executable must reside on a local volume (${targetPath}, mount check failed: ${error?.message ?? error})`,
      })
    }
    if (!meta || !meta.includes("local") || !LOCAL_DARWIN_FS_TYPES.has(meta[0])) {
      throw new assert.AssertionError({
        message: `Refused: OpenCode executable must reside on a local volume (${targetPath}, filesystem is ${meta?.[0] ?? "unknown"})`,
      })
    }
    return
  }
  throw new assert.AssertionError({
    message: `Refused: OpenCode executable must reside on a local volume (${targetPath}, unsupported platform ${platform})`,
  })
}

export async function assertPrivateOpenCodeExecutable(executable, options = {}) {
  const platform = options.platform ?? process.platform
  assert(typeof executable === "string" && path.isAbsolute(executable), "Expected an absolute OpenCode executable path")
  if (platform === "win32" && !isDriveQualifiedWindowsPath(executable)) {
    throw new assert.AssertionError({ message: `Refused: OpenCode executable must be a drive-qualified local path (${executable})` })
  }
  const forbidden = await forbiddenHomeRoots(options.env, { accountHomeOnly: options.accountHomeOnly })
  const normalized = path.resolve(executable)
  assert(!forbidden.some(home => within(home, normalized)), `Refused: OpenCode executable must be outside the user's home (${executable})`)
  const resolved = await canonical(normalized)
  if (platform === "win32" && !isDriveQualifiedWindowsPath(resolved)) {
    throw new assert.AssertionError({ message: `Refused: OpenCode executable resolves to a non-local path (${resolved})` })
  }
  assert(!forbidden.some(home => within(home, resolved)), `Refused: OpenCode executable resolves inside the user's home (${resolved})`)
  await assertLocalVolume(normalized, options)
  if (resolved !== normalized) await assertLocalVolume(resolved, options)
  return resolved
}

async function directoryExposesDisallowedOpenCode(directory, { platform, pathext, forbidden, allowedRoot, options }) {
  const extensions = platform === "win32"
    ? [...new Set(["", ...(pathext || ".COM;.EXE;.BAT;.CMD").toLowerCase().split(";").filter(Boolean)])]
    : [""]
  const resolvedDir = await canonical(directory).catch(() => null)
  const inAllowedRoot = Boolean(allowedRoot && resolvedDir && within(allowedRoot, resolvedDir))
  for (const name of OPENCODE_BIN_NAMES) {
    for (const ext of extensions) {
      const candidate = path.join(directory, `${name}${ext}`)
      const info = await lstat(candidate).catch(() => null)
      if (!info) continue
      if (!info.isFile() && !info.isSymbolicLink()) continue
      if (!inAllowedRoot) return true
      const resolvedTarget = await canonical(candidate).catch(() => null)
      if (!resolvedTarget) return true
      if (platform === "win32" && !isDriveQualifiedWindowsPath(resolvedTarget)) return true
      if (forbidden.some(home => within(home, resolvedTarget))) return true
      if (!within(allowedRoot, resolvedTarget)) return true
      const targetLocal = await assertLocalVolume(resolvedTarget, options).then(() => true, () => false)
      if (!targetLocal) return true
    }
  }
  return false
}

export async function sanitizeBenchPath(rawPath = process.env.PATH, options = {}) {
  const platform = options.platform ?? process.platform
  const delimiter = platform === "win32" ? ";" : ":"
  const pathext = options.pathext ?? process.env.PATHEXT
  const forbidden = await forbiddenHomeRoots(options.env, { accountHomeOnly: options.accountHomeOnly })
  const allowedRoot = options.allowedRoot ? await canonical(path.resolve(options.allowedRoot)).catch(() => path.resolve(options.allowedRoot)) : null
  const rawEntries = String(rawPath ?? "")
    .split(delimiter)
    .map(entry => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean)

  const candidates = []
  for (const entry of rawEntries) {
    if (!path.isAbsolute(entry)) continue
    if (platform === "win32" && !isDriveQualifiedWindowsPath(entry)) continue
    const normalized = path.resolve(entry)
    if (forbidden.some(home => within(home, normalized))) continue
    const resolved = await canonical(normalized).catch(() => null)
    if (!resolved) continue
    if (platform === "win32" && !isDriveQualifiedWindowsPath(resolved)) continue
    if (forbidden.some(home => within(home, resolved))) continue
    candidates.push({ entry, normalized, resolved })
  }

  if (platform === "win32" && !options.probeDriveType && candidates.length > 0) {
    const letters = candidates.flatMap(({ normalized, resolved }) => [normalized[0].toUpperCase(), resolved[0].toUpperCase()])
    await queryWindowsDriveTypes(letters, options).catch(() => {})
  }

  const kept = []
  for (const { entry, normalized, resolved } of candidates) {
    const localInput = await assertLocalVolume(normalized, options).then(() => true, () => false)
    if (!localInput) continue
    const localResolved = resolved === normalized
      ? true
      : await assertLocalVolume(resolved, options).then(() => true, () => false)
    if (!localResolved) continue
    const checkOpts = { platform, pathext, forbidden, allowedRoot, options }
    if (await directoryExposesDisallowedOpenCode(normalized, checkOpts)
      || (resolved !== normalized && await directoryExposesDisallowedOpenCode(resolved, checkOpts))) {
      continue
    }
    kept.push(entry)
  }
  return kept.join(delimiter)
}

export async function sanitizeBenchEnvPath(env, options = {}) {
  const pathKeys = Object.keys(env).filter(key => key.toLowerCase() === "path")
  const rawPath = pathKeys.map(key => env[key]).find(value => typeof value === "string") ?? ""
  const pathextKey = Object.keys(env).find(key => key.toLowerCase() === "pathext")
  const pathext = options.pathext ?? (pathextKey ? env[pathextKey] : process.env.PATHEXT)
  const sanitized = await sanitizeBenchPath(rawPath, { ...options, pathext })
  for (const key of pathKeys) delete env[key]
  env.PATH = sanitized
  return env
}

export async function assertSafeBenchPath(env, allowedRoot, options = {}) {
  const pathKeys = Object.keys(env).filter(key => key.toLowerCase() === "path")
  if (pathKeys.length === 0) return
  const platform = options.platform ?? process.platform
  const delimiter = platform === "win32" ? ";" : ":"
  const pathextKey = Object.keys(env).find(key => key.toLowerCase() === "pathext")
  const pathext = options.pathext ?? (pathextKey ? env[pathextKey] : process.env.PATHEXT)
  const forbidden = await forbiddenHomeRoots(options.env, { accountHomeOnly: options.accountHomeOnly })
  const canonicalAllowed = allowedRoot ? await canonical(path.resolve(allowedRoot)).catch(() => path.resolve(allowedRoot)) : null
  for (const key of pathKeys) {
    const rawPath = env[key]
    if (typeof rawPath !== "string" || !rawPath) continue
    const entries = rawPath.split(delimiter).map(e => e.trim().replace(/^"|"$/g, "")).filter(Boolean)
    for (const entry of entries) {
      assert(path.isAbsolute(entry), `Refused: bench PATH contains a relative entry (${entry})`)
      if (platform === "win32") {
        assert(isDriveQualifiedWindowsPath(entry), `Refused: bench PATH contains a non-local entry (${entry})`)
      }
      const normalized = path.resolve(entry)
      assert(!forbidden.some(home => within(home, normalized)), `Refused: bench PATH contains user home entry (${entry})`)
      const resolved = await canonical(normalized)
      if (platform === "win32") {
        assert(isDriveQualifiedWindowsPath(resolved), `Refused: bench PATH entry resolves to non-local path (${resolved})`)
      }
      assert(!forbidden.some(home => within(home, resolved)), `Refused: bench PATH entry resolves inside user home (${resolved})`)
      await assertLocalVolume(normalized, options)
      if (resolved !== normalized) await assertLocalVolume(resolved, options)
      const checkOpts = { platform, pathext, forbidden, allowedRoot: canonicalAllowed, options }
      assert(
        !(await directoryExposesDisallowedOpenCode(normalized, checkOpts))
          && (resolved === normalized || !(await directoryExposesDisallowedOpenCode(resolved, checkOpts))),
        `Refused: bench PATH entry exposes external OpenCode (${entry})`,
      )
    }
  }
}

export async function ownedOutput(root, directory) {
  assert(path.isAbsolute(directory) && below(root, directory), "Bench output must belong to its checkout")
  const owned = await outsideUserHome(root), resolved = await canonical(directory)
  assert(below(owned, resolved), "Bench output escapes its checkout")
  return resolved
}

export async function assertPrivateProfile(root, env, location) {
  const owned = await outsideUserHome(root)
  async function check(file) {
    assert(typeof file === "string" && path.isAbsolute(file) && below(root, file), "Expected an absolute bench profile path")
    for (let candidate = file;; candidate = path.dirname(candidate)) {
      const present = await lstat(candidate).catch(error => {
        if (error.code !== "ENOENT") throw error
      })
      if (!present) continue
      const canonical = await realpath(candidate) // A dangling link is an error.
      assert(below(owned, canonical), "Bench profile escapes its private fixture")
      return
    }
  }
  for (const name of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "CLI_CONFIG"]) {
    await check(env[name])
  }
  for (const file of Object.values(location)) await check(file)
  await assertSafeBenchPath(env, owned)
}

const within = (root, target) => {
  const relative = path.relative(root, target)
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}

// Resolve even a missing leaf, including dangling links; never create a directory to check it.
async function canonical(file, hops = 0) {
  assert(hops < 64, "Fixture profile path could not be resolved")
  try {
    return await realpath(file)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  const info = await lstat(file).catch(error => { if (error.code !== "ENOENT") throw error })
  if (info?.isSymbolicLink()) return canonical(path.resolve(path.dirname(file), await readlink(file)), hops + 1)
  const parent = path.dirname(file)
  assert.notEqual(parent, file, "Fixture profile path has no existing ancestor")
  return path.join(await canonical(parent, hops + 1), path.basename(file))
}

/** Check the actual home and selected config before spawning either local host. */
export async function assertPrivateHost(env, root, config = env.CLI_CONFIG) {
  const forbidden = await Promise.all(unsafeRoots.map(home => canonical(home)))
  const allowed = value => ![...forbidden, ...unsafeRoots].some(home => within(home, value))
  assert(allowed(root), "Host fixture root is not private")
  const base = await canonical(root)
  const check = async value => {
    assert(typeof value === "string" && path.isAbsolute(value), "Host fixture needs an explicit private profile")
    assert(allowed(value), "Host fixture profile is not private")
    const resolved = await canonical(value)
    assert(within(base, resolved) && allowed(resolved), "Host fixture profile is not private")
    return resolved
  }
  await check(root)
  const home = await check(env.HOME)
  assert.equal(await check(env.USERPROFILE), home, "Host home must match the fixture on both platforms")
  await Promise.all(["APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"].map(key => check(env[key])))
  for (const [key, value] of Object.entries(env)) if (key.toUpperCase().startsWith("XDG_")) await check(value)
  await check(config)
  const folder = /\.(?:json|ya?ml)$/i.test(config) ? path.dirname(config) : config
  await check(folder)
  await check(/\.ya?ml$/i.test(config) ? config : path.join(folder, "config.yaml"))
  await assertSafeBenchPath(env, base)
}

const PROFILE_VARIABLES = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
  "XDG_CACHE_HOME", "npm_config_userconfig", "npm_config_cache", "CLI_CONFIG"]
/** Refuses to start a fixture child whose profile folders or resolved CodeNomad config folder lie
 * under the account's real home: a fixture never reads or writes the user's own profile. */
export function assertOutsideAccount(env, ...configFolders) {
  for (const key of PROFILE_VARIABLES) {
    if (env[key]) assert(!unsafeRoots.some(home => within(home, path.resolve(env[key]))), `Refused: ${key}=${env[key]} is under the user's home`)
  }
  for (const folder of configFolders) assert(!unsafeRoots.some(home => within(home, path.resolve(folder))), `Refused: CodeNomad config ${folder} is under the user's home`)
}

function extractConfigArg(argv, env) {
  let cliConfig
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if ((arg === "--config" || arg === "-c") && i + 1 < argv.length) {
      cliConfig = argv[i + 1]
      i += 1
    } else if (arg.startsWith("--config=")) {
      cliConfig = arg.slice("--config=".length)
    } else if (arg.startsWith("-c=")) {
      cliConfig = arg.slice("-c=".length)
    }
  }
  return cliConfig || env?.CLI_CONFIG
}

/** Guard for direct or harness launches of `ts-server.mjs`: enforces private profile paths,
 * private npm fallback prefix, safe configured `server.opencodeBinary`, and sanitized `PATH`. */
export async function assertPrivateTsServerLaunch(argv = process.argv.slice(2), env = process.env, options = {}) {
  const platform = options.platform ?? process.platform
  const forbidden = await forbiddenHomeRoots({}, { accountHomeOnly: true })
  const assertPrivateLocalPath = async (label, value) => {
    assert(typeof value === "string" && path.isAbsolute(value), `Refused: TS server ${label} must be an explicit absolute private path`)
    if (platform === "win32") {
      assert(isDriveQualifiedWindowsPath(value), `Refused: TS server ${label} must be a drive-qualified local path (${value})`)
    }
    const normalized = path.resolve(value)
    assert(!forbidden.some(home => within(home, normalized)), `Refused: TS server ${label} must be outside the user's home (${value})`)
    const resolved = await canonical(normalized)
    if (platform === "win32") {
      assert(isDriveQualifiedWindowsPath(resolved), `Refused: TS server ${label} resolves to a non-local path (${resolved})`)
    }
    assert(!forbidden.some(home => within(home, resolved)), `Refused: TS server ${label} resolves inside the user's home (${resolved})`)
    await assertLocalVolume(normalized, options)
    if (resolved !== normalized) await assertLocalVolume(resolved, options)
    return resolved
  }

  const configPath = extractConfigArg(argv, env)
  const resolvedConfig = await assertPrivateLocalPath("config", configPath)
  const resolvedHome = await assertPrivateLocalPath("HOME", env.HOME)
  await assertPrivateLocalPath("USERPROFILE", env.USERPROFILE)
  if (platform === "win32") {
    await assertPrivateLocalPath("APPDATA", env.APPDATA)
    await assertPrivateLocalPath("LOCALAPPDATA", env.LOCALAPPDATA)
  }
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue
    if (key.toUpperCase().startsWith("XDG_") || key.toLowerCase() === "npm_config_prefix") {
      await assertPrivateLocalPath(key, value)
    }
  }

  const configuredNpmPrefix = Object.entries(env).find(([key]) => key.toLowerCase() === "npm_config_prefix")?.[1]
  const npmPrefix = configuredNpmPrefix && path.isAbsolute(configuredNpmPrefix)
    ? configuredNpmPrefix
    : (platform === "win32" ? path.join(env.APPDATA, "npm") : path.join(resolvedHome, ".local"))
  const resolvedNpmPrefix = await assertPrivateLocalPath("npm prefix", npmPrefix)
  const npmBinDir = platform === "win32" ? resolvedNpmPrefix : path.join(resolvedNpmPrefix, "bin")
  if (await lstat(npmBinDir).catch(() => null)) {
    const resolvedNpmBin = await assertPrivateLocalPath("npm bin directory", npmBinDir)
    const pathextKey = Object.keys(env).find(key => key.toLowerCase() === "pathext")
    const pathext = options.pathext ?? (pathextKey ? env[pathextKey] : process.env.PATHEXT)
    assert(
      !(await directoryExposesDisallowedOpenCode(resolvedNpmBin, {
        platform,
        pathext,
        forbidden,
        allowedRoot: resolvedNpmPrefix,
        options,
      })),
      `Refused: TS server npm bin exposes escaping OpenCode (${resolvedNpmBin})`,
    )
  }
  const npmExe = path.join(resolvedNpmPrefix, ...(platform === "win32" ? [] : ["lib"]), "node_modules", "@opencode", "cli", "bin", "opencode.exe")
  if (await lstat(npmExe).catch(() => null)) {
    await assertPrivateOpenCodeExecutable(npmExe, { ...options, env: {}, accountHomeOnly: true })
  }

  const configStat = await lstat(resolvedConfig).catch(() => null)
  const yamlPath = (/\.ya?ml$/i.test(resolvedConfig) || configStat?.isFile())
    ? resolvedConfig
    : path.join(resolvedConfig, "config.yaml")
  const resolvedYaml = await assertPrivateLocalPath("config YAML", yamlPath)
  if (await lstat(resolvedYaml).catch(() => null)) {
    const { parse: parseYaml } = await import("yaml")
    const parsed = parseYaml(await readFile(resolvedYaml, "utf8"))
    const configuredBinary = parsed?.server?.opencodeBinary
    if (configuredBinary !== undefined && configuredBinary !== null) {
      assert(typeof configuredBinary === "string", "Refused: server.opencodeBinary must be a string")
      const trimmed = configuredBinary.trim()
      if (trimmed.length > 0 && trimmed !== "opencode" && trimmed !== "opencode2") {
        await assertPrivateOpenCodeExecutable(trimmed, { ...options, env: {}, accountHomeOnly: true })
      }
    }
  }

  await sanitizeBenchEnvPath(env, { ...options, env: {}, accountHomeOnly: true })
}
